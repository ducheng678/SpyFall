export function normalizeRoomCodeInput(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 4);
}

export function requireValidRoomCode(value) {
  const code = String(value ?? "").trim();
  if (!/^\d{4}$/.test(code)) {
    throw new Error("房间码必须是 4 位数字");
  }
  return code;
}

export function createNumericRoomCode(existingCodes, rng = Math.random) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(Math.floor(rng() * 10000)).padStart(4, "0");
    if (!existingCodes.has(code)) return code;
  }
  throw new Error("房间号生成失败，请重试");
}
