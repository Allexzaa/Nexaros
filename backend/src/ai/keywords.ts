// Hardcoded base list — always applied, cannot be removed by any business
const BASE_DISTRESS_KEYWORDS = [
  'emergency',
  'urgent help',
  'threatening',
  'lawyer',
  'lawsuit',
];

export function isDistressMessage(text: string, businessKeywords: string[] = []): boolean {
  const lower = text.toLowerCase();
  const allKeywords = [...BASE_DISTRESS_KEYWORDS, ...businessKeywords];
  return allKeywords.some((kw) => lower.includes(kw.toLowerCase()));
}
