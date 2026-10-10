export function publishedReleaseVersion(readme) {
  return readme.match(/Latest published release: \*\*v([0-9.]+)\*\*/)?.[1] ?? null;
}

export function publishedReleaseNotice(sourceVersion, publishedVersion, repositoryUrl) {
  const source = `คู่มือนี้อัปเดตตาม source \`v${sourceVersion}\``;
  return publishedVersion
    ? `${source}; public release \`v${publishedVersion}\` คือรุ่นที่เผยแพร่แล้วบน [GitHub Releases](${repositoryUrl}/releases/tag/v${publishedVersion})`
    : `${source}; gotzji ยังไม่มีรุ่นที่เผยแพร่อย่างเป็นทางการ`;
}
