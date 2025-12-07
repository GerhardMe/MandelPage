{
  description = "Astro project dev shell with Node + pnpm + emcc";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_20
            pnpm
            emscripten # <- this gives you emcc
          ];

          shellHook = ''
            echo "🚀 Entered Astro dev shell"
            echo "Node: $(node -v)"
            echo "pnpm: $(pnpm -v)"
            echo "emcc: $(command -v emcc || echo 'not found')"
          '';
        };
      });
}
