# Camera background models

MODNet (https://github.com/ZHKKKe/MODNet, Apache-2.0) portrait matting, from the ONNX export at
https://huggingface.co/Xenova/modnet, converted for onnxruntime-web's WebGL backend at two fixed input sizes
(512×288 and 384×224): shapes folded, no int64, channel slices as Split, the quarter-size input taken from the
half-size one. Built by `Backend/scripts/modnet/build_modnet_webgl.py` in the Ubex Chat repository.

Each model is split into 4.5 MB parts (`<name>.<n>.bin`, joined in order) and served by jsDelivr, pinned to a
commit, to the web app's camera background (`Frontend/Interface/shared/background-matting.js`). Not part of the
desktop app's installer.
