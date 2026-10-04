"""Export the dense PNSN network; preserve upstream preprocessing and NMS on CPU."""

import argparse
import json
from pathlib import Path
import torch

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--batch", type=int, default=8)
args = parser.parse_args()
torch.set_num_threads(4)
model = torch.jit.load(args.model, map_location="cpu").eval()
network = model.model if hasattr(model, "model") else model
network = torch.jit.freeze(network)
torch.manual_seed(20261002)
x = torch.randn(args.batch, 3, 10240)
torch.onnx.export(
    network,
    x,
    args.output,
    input_names=["wave"],
    output_names=["probabilities"],
    opset_version=14,
    dynamo=False,
    do_constant_folding=True,
)
import numpy as np

with torch.no_grad():
    reference = network(x).numpy()
np.savez(str(Path(args.output).with_suffix("")) + "_input.npz", wave=x.numpy())
np.savez(
    str(Path(args.output).with_suffix("")) + "_reference.npz", probabilities=reference
)
print(
    json.dumps(
        {"input": list(x.shape), "output": list(reference.shape), "model": args.output}
    )
)
