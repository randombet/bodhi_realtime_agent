"""Deploy vLLM-Omni serving Qwen3-Omni-30B-A3B-Instruct on Modal,
exposing the OpenAI-style /v1/realtime WebSocket endpoint.

ARCHITECTURE: vLLM-Omni serves Qwen3-Omni-MoE as THREE pipeline stages — 0
(thinker), 1 (talker), 2 (code2wav). The bundled `qwen3_omni_moe.yaml` is a
2x H100 layout (stage 0 on cuda:0, stages 1+2 co-located on cuda:1) but ships
with `async_chunk: true`, which the upstream docs say is incompatible with the
OpenAI-style `/v1/realtime` WebSocket. We bake a conservative realtime overlay
YAML into the image and pass it via `--deploy-config`. vLLM-Omni handles
per-stage device pinning itself based on each stage's `devices` field.

Usage:
    modal deploy examples/qwen-realtime/modal/deploy.py
    # → wss://<acct>--qwen3-omni-realtime-serve.modal.run/v1/realtime

    # Optional A100 retry using the same low-memory smoke profile:
    QWEN_MODAL_GPU=A100-80GB:2 modal deploy examples/qwen-realtime/modal/deploy.py
"""

import hashlib
import os
import pathlib

import modal

APP_NAME = "qwen3-omni-realtime"
MODEL_ID = "Qwen/Qwen3-Omni-30B-A3B-Instruct"
PORT = 8091
GPU_SPEC = os.environ.get("QWEN_MODAL_GPU", "H100:2")

# Custom 3-stage realtime YAML baked into the image.
LOCAL_YAML = pathlib.Path(__file__).with_name("qwen3_omni_realtime.yaml")
IMAGE_YAML_PATH = "/opt/qwen3_omni_realtime.yaml"

# Content fingerprint of the overlay. Attempt 5 booted with the upstream 65k
# config because a stale `add_local_file` layer was reused; this hash makes the
# image rebuild keyed to the YAML's *content*, and lets the container assert at
# runtime that the file it actually baked matches what we deployed.
#
# This module is imported in two places: locally at `modal deploy` time (where
# LOCAL_YAML exists and we compute the real hash to drive the build) and inside
# the container when the function loads (where LOCAL_YAML is absent — the file
# lives at IMAGE_YAML_PATH — so we fall back to the SHA baked into the env).
YAML_SHA = (
    hashlib.sha256(LOCAL_YAML.read_bytes()).hexdigest()[:12]
    if LOCAL_YAML.exists()
    else os.environ.get("QWEN_YAML_SHA", "unknown")
)

app = modal.App(APP_NAME)

# Persist HF weights across cold starts (already populated by the previous attempt).
hf_cache = modal.Volume.from_name("hf-cache", create_if_missing=True)

image = (
    # v0.20.0: self-consistent vllm/vllm-omni release; `latest`/v0.21.0rc1 has
    # a broken vllm/vllm-omni version mismatch out-of-the-box.
    modal.Image.from_registry("vllm/vllm-omni:v0.20.0", add_python="3.12")
    .pip_install("huggingface_hub[hf_transfer]")
    # Cache-bust: this layer's digest changes whenever YAML_SHA changes, which
    # forces the add_local_file copy below (and everything after) to rebuild
    # from fresh build context instead of a stale cached layer.
    .run_commands(f"echo 'qwen3-omni overlay sha={YAML_SHA}' > /opt/qwen3_omni_yaml_sha")
    # Bake the overlay YAML into the image so vllm-omni can read it at startup.
    .add_local_file(str(LOCAL_YAML), IMAGE_YAML_PATH, copy=True)
    .env(
        {
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "HF_HOME": "/cache/hf",
            "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
            "VLLM_LOGGING_LEVEL": "INFO",
            # Read back in-container to verify the baked file matches this deploy.
            "QWEN_YAML_SHA": YAML_SHA,
        }
    )
)


@app.function(
    image=image,
    gpu=GPU_SPEC,                  # YAML pins stage 0 → device "0", stages 1+2 → device "1"
    volumes={"/cache/hf": hf_cache},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    scaledown_window=300,
    timeout=60 * 60 * 6,
    max_containers=1,
)
@modal.concurrent(max_inputs=20)
@modal.web_server(port=PORT, startup_timeout=60 * 30)
def serve():
    """Single vllm serve invocation; vLLM-Omni reads the YAML and spawns the
    3 stage processes on the right GPUs itself."""
    import hashlib
    import os
    import subprocess
    import sys

    print(f"[serve] CUDA_VISIBLE_DEVICES={os.environ.get('CUDA_VISIBLE_DEVICES')}", flush=True)
    subprocess.run(["nvidia-smi", "-L"], check=False)
    subprocess.run(["nvidia-smi"], check=False)
    with open(IMAGE_YAML_PATH, "rb") as f:
        yaml_bytes = f.read()
    yaml_text = yaml_bytes.decode()

    # Cache-bust assertion: the SHA of the file actually baked into this image
    # must match the SHA we computed locally at deploy time. A mismatch means a
    # stale layer was reused (the Attempt-5 failure mode) — fail before paying
    # for a multi-minute model load.
    expected_sha = os.environ.get("QWEN_YAML_SHA")
    actual_sha = hashlib.sha256(yaml_bytes).hexdigest()[:12]
    print(f"[serve] deploy config path={IMAGE_YAML_PATH}", flush=True)
    print(f"[serve] deploy config sha={actual_sha} expected={expected_sha}", flush=True)
    if expected_sha and actual_sha != expected_sha:
        raise RuntimeError(
            f"Stale deploy config baked into image: sha {actual_sha} != expected "
            f"{expected_sha}. Rebuild the image (modal will rebuild now that the "
            "YAML content changed) before retrying."
        )
    print("[serve] deploy config preview:\n" + "\n".join(yaml_text.splitlines()[:90]), flush=True)
    required_config_markers = [
        "PROFILE_MARKER: qwen3_omni_realtime_smoke_2026_05_30_v2",
        "max_model_len: 8192",
        "max_num_batched_tokens: 8192",
        "max_num_seqs: 8",
        "gpu_memory_utilization: 0.82",
        "max_num_batched_tokens: 16384",
    ]
    missing_markers = [marker for marker in required_config_markers if marker not in yaml_text]
    if missing_markers:
        raise RuntimeError(
            "Stale or wrong deploy config baked into image; missing markers: "
            + ", ".join(missing_markers)
        )

    cmd = [
        "vllm", "serve", MODEL_ID, "--omni",
        "--deploy-config", IMAGE_YAML_PATH,
        "--host", "0.0.0.0",
        "--port", str(PORT),
        # Belt-and-suspenders: YAML sets async_chunk:false; CLI repeats it.
        "--no-async-chunk",
    ]
    print(f"[serve] launching: {' '.join(cmd)}", flush=True)
    subprocess.Popen(cmd, stdout=sys.stdout, stderr=sys.stderr)
