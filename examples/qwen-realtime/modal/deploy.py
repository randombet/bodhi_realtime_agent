"""Deploy vLLM-Omni serving Qwen3-Omni-30B-A3B-Instruct on Modal,
exposing the OpenAI-style /v1/realtime WebSocket endpoint.

ARCHITECTURE: vLLM-Omni runs Qwen3-Omni as TWO stages — thinker (text/
reasoning) and talker (speech generation) — as separate processes pinned to
separate GPUs via CUDA_VISIBLE_DEVICES, coordinated via an omni-master port.
A single A100-80GB is insufficient (thinker alone takes ~60 GiB); use 2× GPUs.

Usage:
    modal deploy examples/qwen-realtime/modal/deploy.py
    # → wss://<acct>--qwen3-omni-realtime-serve.modal.run/v1/realtime
"""

import modal

APP_NAME = "qwen3-omni-realtime"
MODEL_ID = "Qwen/Qwen3-Omni-30B-A3B-Instruct"
PORT = 8091
OMNI_MASTER_PORT = 26000

app = modal.App(APP_NAME)

# Persist HF weights across cold starts (already populated by the previous attempt).
hf_cache = modal.Volume.from_name("hf-cache", create_if_missing=True)

image = (
    # v0.20.0: self-consistent vllm/vllm-omni release; `latest`/v0.21.0rc1 has
    # a broken vllm/vllm-omni version mismatch out-of-the-box.
    modal.Image.from_registry("vllm/vllm-omni:v0.20.0", add_python="3.12")
    .pip_install("huggingface_hub[hf_transfer]")
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
    gpu="A100-80GB:2",                 # 2 GPUs: thinker + talker
    volumes={"/cache/hf": hf_cache},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    scaledown_window=300,
    timeout=60 * 60 * 6,
    max_containers=1,
)
@modal.web_server(port=PORT, startup_timeout=60 * 30)
def serve():
    """Launch two vLLM-Omni processes in-container: talker (stage 1, headless)
    on GPU 1, then thinker + API server (stage 0) on GPU 0. They handshake via
    127.0.0.1:OMNI_MASTER_PORT. Modal proxies port 8091 (thinker's API)."""
    import os
    import subprocess
    import sys

    common = [
        "vllm", "serve", MODEL_ID, "--omni",
        "--no-async-chunk",                                  # REQUIRED for /v1/realtime
        "--omni-master-address", "127.0.0.1",
        "--omni-master-port", str(OMNI_MASTER_PORT),
        "--gpu-memory-utilization", "0.92",
    ]

    # Stage 1 (talker) — headless, GPU 1, no API server.
    talker_cmd = [
        *common,
        "--stage-id", "1",
        "--headless",
    ]
    talker_env = {**os.environ, "CUDA_VISIBLE_DEVICES": "1"}
    print(f"[serve] launching talker on GPU 1: {' '.join(talker_cmd)}", flush=True)
    subprocess.Popen(talker_cmd, env=talker_env, stdout=sys.stdout, stderr=sys.stderr)

    # Stage 0 (thinker + API server) — GPU 0, binds PORT for /v1/realtime.
    thinker_cmd = [
        *common,
        "--stage-id", "0",
        "--host", "0.0.0.0",
        "--port", str(PORT),
    ]
    thinker_env = {**os.environ, "CUDA_VISIBLE_DEVICES": "0"}
    print(f"[serve] launching thinker+api on GPU 0: {' '.join(thinker_cmd)}", flush=True)
    subprocess.Popen(thinker_cmd, env=thinker_env, stdout=sys.stdout, stderr=sys.stderr)
