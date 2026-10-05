# Ubex Chat Desktop

Ubex Chat for Linux and Windows: an Electron window around https://chat.ubex.ai.

Downloads: https://github.com/andreitechvision/ubex-desktop/releases/latest

## Build

```sh
npm install
npm start            # run from source
npm run dist:linux   # dist/Ubex-Chat-x86_64.rpm, Ubex-Chat-amd64.deb, Ubex-Chat-x86_64.AppImage
npm run dist:win     # dist/Ubex-Chat-Setup.exe (needs Wine when built on Linux)
```

On Fedora 44 the .rpm/.deb step needs `libcrypt.so.1` (`sudo dnf install libxcrypt-compat`); `release.sh` fetches it by itself.

## Release

```sh
./release.sh 1.1.0 "What changed"
```

It builds the Linux installers, pushes and tags the source, creates the GitHub release, and
sets the latest version in the Ubex Chat interface so older installs show the update banner.
Installed apps download the update by themselves and offer "Restart to update".

Windows is built by GitHub Actions (`.github/workflows/windows.yml`) on a Windows machine:
it starts when the release is published and adds `Ubex-Chat-Setup.exe` to it. To build it for
an existing release: Actions → Windows installer → Run workflow → the tag.

The download links in Ubex Chat use `releases/latest/download/<file>`, so they follow the newest release.
