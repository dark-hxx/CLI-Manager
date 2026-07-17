# Bundled ConPTY Runtime

Source: Microsoft Windows Terminal release `v1.24.11321.0`

Asset: `Microsoft.Windows.Console.ConPTY.1.24.260512001.nupkg`

URL: `https://github.com/microsoft/terminal/releases/download/v1.24.11321.0/Microsoft.Windows.Console.ConPTY.1.24.260512001.nupkg`

Package SHA256:

```text
3c66a99d38b5c2ac4c7552b7632cbbef23a1911aca5e20370109eb555a15d077
```

Bundled files:

```text
8261dd05f09ea8d54317eeacb8ee62790f5b9e2e40b1e2d5728425c0c42fbdf8  arm64/conpty.dll
29cb3a9471c5b13bfb3ac812043e496199ba776ced1c5e14d30cb1234433a437  arm64/OpenConsole.exe
c46dcd04f52b97f6a8cf53e8f547c85a821660bed18de2b3344afcd4a8389ad6  x64/conpty.dll
47828c3fe080212f69dfdb39ab3673170fcc7445924c76fe003cefd18247dd5d  x64/OpenConsole.exe
90ab3afca795201c02d343f5724f910b1698ec5b378dc792d5dec98810f95870  x86/conpty.dll
52c5a30d823d830812bc3fe104f02d847c23c6b8cd10c970b9bdbc53ff8f3f37  x86/OpenConsole.exe
```

Purpose: CLI-Manager's direct ConPTY adapter first tries to load `conpty.dll` from the configured runtime path and falls back to the `kernel32.dll` ConPTY API. CLI-Manager prepends the matching resource directory to `PATH` when the Windows compatibility setting is enabled so affected Windows builds can use this newer OpenConsole host.
