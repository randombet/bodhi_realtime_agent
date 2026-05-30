"""Cheap CPU-only Modal function that dumps the bundled vLLM-Omni deploy YAMLs.

Reads them from the container filesystem (no `import vllm_omni` — that lives in
the container's Python install, separate from Modal's add_python interpreter).

    modal run examples/qwen-realtime/modal/dump_yaml.py
"""

import modal

app = modal.App("qwen3-omni-inspect-yaml")
image = modal.Image.from_registry("vllm/vllm-omni:v0.20.0", add_python="3.12").pip_install("pyyaml")


@app.function(image=image, timeout=120)
def dump():
    import json
    import os
    import yaml

    candidates = [
        "/usr/local/lib/python3.12/dist-packages/vllm_omni/deploy",
        "/usr/lib/python3.12/dist-packages/vllm_omni/deploy",
    ]
    deploy_dir = next((p for p in candidates if os.path.isdir(p)), None)
    if not deploy_dir:
        print("Could not find vllm_omni/deploy. Walking /usr to locate it...")
        for root, dirs, files in os.walk("/usr"):
            if root.endswith("vllm_omni/deploy"):
                deploy_dir = root
                break
        if not deploy_dir:
            print("FAILED — vllm_omni/deploy not on disk in this image.")
            return
    print(f"\n=== deploy dir: {deploy_dir}\n")

    print("=== contents:\n")
    for name in sorted(os.listdir(deploy_dir)):
        print(f"  {name}")
    print()

    for name in sorted(os.listdir(deploy_dir)):
        if not name.endswith((".yaml", ".yml")):
            continue
        path = os.path.join(deploy_dir, name)
        print(f"=== {name} ({os.path.getsize(path)} B)\n")
        with open(path) as f:
            raw = f.read()
        print(raw)
        print()
        try:
            parsed = yaml.safe_load(raw)
        except Exception as e:
            print(f"  (yaml parse error: {e})")
            continue
        hits = []

        def walk(node, p):
            if isinstance(node, dict):
                for k, v in node.items():
                    if k in ("async_chunk", "devices", "stage", "stages", "stage_id", "device", "device_ids"):
                        hits.append((p + "." + str(k), v))
                    walk(v, p + "." + str(k))
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, p + f"[{i}]")

        walk(parsed, name)
        if hits:
            print("  -- keys of interest:")
            for path_str, val in hits:
                short = json.dumps(val) if not isinstance(val, (dict, list)) else f"<{type(val).__name__} of len {len(val)}>"
                print(f"     {path_str}  =  {short}")
        print()


@app.local_entrypoint()
def main():
    dump.remote()
