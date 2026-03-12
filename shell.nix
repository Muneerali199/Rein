{ pkgs ? import <nixpkgs> {} }:

let
  sharedLibs = with pkgs; [
    gtk3
    nss
    nspr
    alsa-lib
    libglvnd
    dbus
    fuse
    libxtst
    libx11
    libxext
  ];
in
pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs_24
    procps
    appimage-run
  ] ++ sharedLibs;

  shellHook = ''
    export LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath sharedLibs}:$LD_LIBRARY_PATH
    alias g="git"
    npm i
    npm run dist
    appimage-run ./dist/Rein-1.0.0.AppImage
    # npm run electron-dev
  '';
}


