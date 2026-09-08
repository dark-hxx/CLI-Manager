const PI_TOOL_BACKGROUND_RGB = new Set([
  0x282832, // dark toolPendingBg
  0x283228, // dark toolSuccessBg
  0x3c2828, // dark toolErrorBg
  0xe8e8f0, // light toolPendingBg
  0xe8f0e8, // light toolSuccessBg
  0xf0e8e8, // light toolErrorBg
]);

const PI_SAFE_TOOL_BACKGROUND_256 = new Set([22, 52, 255]);
const CSI_FINAL_BYTE_MIN = 0x40;
const CSI_FINAL_BYTE_MAX = 0x7e;

export interface PiAnsiTransform {
  transform(text: string): string;
  reset(): void;
}

export function isPiToolBackgroundRgb(color: number): boolean {
  return PI_TOOL_BACKGROUND_RGB.has(color);
}

function replaceColonBackground(parameter: string): string {
  const parts = parameter.split(":");
  if (parts[0] !== "48") return parameter;

  if (parts[1] === "5") {
    const color = Number(parts[parts.length - 1]);
    return PI_SAFE_TOOL_BACKGROUND_256.has(color) ? "49" : parameter;
  }

  if (parts[1] !== "2" || parts.length < 5) return parameter;
  const rgb = parts.slice(-3).map(Number);
  if (rgb.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return parameter;
  }
  const color = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  return isPiToolBackgroundRgb(color) ? "49" : parameter;
}

function replaceSgrParameters(body: string): string {
  const parameters = body.split(";");
  const result: string[] = [];

  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    if (parameter.includes(":")) {
      result.push(replaceColonBackground(parameter));
      continue;
    }
    if (parameter !== "48") {
      result.push(parameter);
      continue;
    }

    const mode = parameters[index + 1];
    if (mode === "5" && index + 2 < parameters.length) {
      const color = Number(parameters[index + 2]);
      if (PI_SAFE_TOOL_BACKGROUND_256.has(color)) {
        result.push("49");
        index += 2;
        continue;
      }
    }
    if (mode === "2" && index + 4 < parameters.length) {
      const rgb = parameters.slice(index + 2, index + 5).map(Number);
      if (rgb.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        const color = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
        if (isPiToolBackgroundRgb(color)) {
          result.push("49");
          index += 4;
          continue;
        }
      }
    }
    result.push(parameter);
  }

  return result.join(";");
}

function replaceCompleteCsi(sequence: string): string {
  if (!sequence.endsWith("m")) return sequence;
  return `\x1b[${replaceSgrParameters(sequence.slice(2, -1))}m`;
}

export function createPiAnsiTransform(): PiAnsiTransform {
  let pendingCsi = "";

  return {
    transform(text) {
      const input = `${pendingCsi}${text}`;
      pendingCsi = "";
      let result = "";
      let index = 0;

      while (index < input.length) {
        const escapeIndex = input.indexOf("\x1b[", index);
        if (escapeIndex < 0) {
          const tail = input.slice(index);
          if (tail.endsWith("\x1b")) {
            pendingCsi = "\x1b";
            return result + tail.slice(0, -1);
          }
          return result + tail;
        }
        result += input.slice(index, escapeIndex);

        let end = escapeIndex + 2;
        while (end < input.length) {
          const code = input.charCodeAt(end);
          if (code >= CSI_FINAL_BYTE_MIN && code <= CSI_FINAL_BYTE_MAX) break;
          end += 1;
        }
        if (end >= input.length) {
          pendingCsi = input.slice(escapeIndex);
          return result;
        }

        result += replaceCompleteCsi(input.slice(escapeIndex, end + 1));
        index = end + 1;
      }

      return result;
    },
    reset() {
      pendingCsi = "";
    },
  };
}
