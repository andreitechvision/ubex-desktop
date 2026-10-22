# Camera background models

MODNet (https://github.com/ZHKKKe/MODNet, Apache-2.0) portrait matting, from the ONNX export at
https://huggingface.co/Xenova/modnet, converted for onnxruntime-web's WebGL backend at a fixed input size
(384×224): shapes folded, no int64, channel slices as Split, the quarter-size input taken from the
half-size one. Built by `Backend/scripts/modnet/build_modnet_webgl.py` in the Ubex Chat repository.

The model is split into 4.5 MB parts (`<name>.<n>.bin`, joined in order) and served by jsDelivr, pinned to a
commit (jsDelivr serves at most 50 MB per commit), to the web app's camera background on WebGL
(`Frontend/Interface/shared/background-matting.js`); WebGPU runs the original from Hugging Face. Not part of the
desktop app's installer.
