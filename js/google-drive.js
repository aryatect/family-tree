export function extractDriveFileId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[\w-]{20,}$/.test(trimmed)) return trimmed;
  const patterns = [/\/d\/([\w-]+)/, /[?&]id=([\w-]+)/];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return m[1];
  }
  return null;
}

export function getImageUrl(fileId, width = 400) {
  if (!fileId) return null;
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${width}`;
}

export function getVideoEmbedUrl(fileId) {
  if (!fileId) return null;
  return `https://drive.google.com/file/d/${fileId}/preview`;
}
