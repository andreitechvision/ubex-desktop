# Ubex Desktop

Ubex for Linux and Windows: an Electron window around https://chat.ubex.ai.

Downloads: https://github.com/andreitechvision/ubex-desktop/releases/latest

## Build

```sh
npm install
npm start            # run from source
npm run dist:linux   # dist/Ubex-x86_64.rpm, Ubex-amd64.deb, Ubex-x86_64.AppImage
npm run dist:win     # dist/Ubex-Setup.exe (needs Wine when built on Linux)
```

On Fedora 44 the .rpm/.deb step needs `libcrypt.so.1` (`sudo dnf install libxcrypt-compat`).

## Release

Bump `version` in package.json, build, then:

```sh
gh release create v<version> dist/Ubex-x86_64.rpm dist/Ubex-amd64.deb dist/Ubex-x86_64.AppImage \
  dist/Ubex-Setup.exe dist/Ubex-Setup.exe.blockmap dist/latest.yml dist/latest-linux.yml
```

The download links in the Ubex app use `releases/latest/download/<file>`, so they follow the newest release.
