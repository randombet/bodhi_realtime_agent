"""Deploy vLLM-Omni serving Qwen3-Omni-30B-A3B-Instruct on Modal,
exposing the OpenAI-style /v1/realtime WebSocket endpoint.

ARCHITECTURE: vLLM-Omni serves Qwen3-Omni-MoE as THREE pipeline stages — 0
(thinker), 1 (talker), 2 (code2wav). The bundled `qwen3_omni_moe.yaml` is the
verified 2-GPU layout (stage 0 on cuda:0, stages 1+2 co-located on cuda:1) but
ships with `async_chunk: true`, which the upstream docs say is incompatible
with the OpenAI-style `/v1/realtime` WebSocket. We bake an overlay YAML —
identical to upstream except `async_chunk: false` — into the image and pass
it via `--deploy-config`. vLLM-Omni handles per-stage device pinning itself
based on each stage's `devices` field; no CUDA_VISIBLE_DEVICES juggling.

Usage:
    modal deploy examples/qwen-realtime/modal/deploy.py
    # → wss://<acct>--qwen3-omni-realtime-serve.modal.run/v1/realtime
"""

import pathlib

import modal

APP_NAME = "qwen3-omni-realtime"
MODEL_ID = "Qwen/Qwen3-Omni-30B-A3B-Instruct"
PORT = 8091

# Custom 3-stage YAML (qwen3_omni_moe + async_chunk:false) baked into the image.
LOCAL_YAML = pathlib.Path(__file__).with_name("qwen3_omni_realtime.yaml")
IMAGE_YAML_PATH = "/opt/qwen3_omni_realtime.yaml"

app = modal.App(APP_NAME)

# Persist HF weights across cold starts (already populated by the previous attempt).
hf_cache = modal.Volume.from_name("hf-cache", create_if_missing=True)

image = (
    # v0.20.0: self-consistent vllm/vllm-omni release; `latest`/v0.21.0rc1 has
    # a broken vllm/vllm-omni version mismatch out-of-the-box.
    modal.Image.from_registry("vllm/vllm-omni:v0.20.0", add_python="3.12")
    .pip_install("huggingface_hub[hf_transfer]")
    # Bake the overlay YAML into the image so vllm-omni can read it at startup.
    .add_local_file(str(LOCAL_YAML), IMAGE_YAML_PATH, copy=True)
    .env(
        {
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "HF_HOME": "/cache/hf",
            "VLLM_LOGGING_LEVEL": "INFO",
        }
    )
)


@app.function(
    image=image,
    gpu="A100-80GB:2",             # YAML pins stage 0 → device "0", stages 1+2 → device "1"
    volumes={"/cache/hf": hf_cache},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    scaledown_window=300,
    timeout=60 * 60 * 6,
    max_containers=1,
)
@modal.web_server(port=PORT, startup_timeout=60 * 30)
def serve():
    """Single vllm serve invocation; vLLM-Omni reads the YAML and spawns the
    3 stage processes on the right GPUs itself."""
    import subprocess
    import sys

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
