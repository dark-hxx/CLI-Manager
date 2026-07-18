# CLI-Manager Desktop Pet Packages

Desktop pets use the .clipet extension. A .clipet file is a ZIP archive with
this shape:

    manifest.json
    pet.svg
    assets/optional-image.png

manifest.json uses schema version 1:

    {
      "schemaVersion": 1,
      "id": "author.pet-name",
      "version": "1.0.0",
      "name": {
        "zh-CN": "宠物名称",
        "en-US": "Pet name"
      },
      "description": {
        "zh-CN": "宠物说明",
        "en-US": "Pet description"
      },
      "author": "Author",
      "license": "CC0-1.0",
      "engine": "image-v1",
      "canvas": {
        "width": 160,
        "height": 160
      },
      "states": {
        "idle": { "file": "pet.svg" },
        "working": { "file": "pet.svg" },
        "waiting": { "file": "pet.svg" },
        "success": { "file": "pet.svg" },
        "error": { "file": "pet.svg" },
        "sleeping": { "file": "pet.svg" }
      }
    }

Only png, webp, and sanitized svg assets are accepted. HTML, JavaScript,
executables, symbolic links, absolute paths, and parent-directory paths are
rejected. Packages are limited to 25 MB compressed, 30 MB extracted, 40
archive entries, and four directory levels.

Published packages live in public/pet-catalog/packages/. Each catalog item
must include its SHA-256 hash, byte size, minimum CLI-Manager version, preview
URL, and package URL. The Rust installer validates the catalog, checksum,
archive structure, manifest, and every referenced asset before committing an
installation to ~/.cli-manager/pets/installed/.
