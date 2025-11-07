export const generateWarehouseCode = (name: string) => {
  const normalized = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
  const base = normalized || 'AUTO';
  const random = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'XXXX';
  return `WH-${base}-${random}`;
};

const stripDiacritics = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

const sanitizeForCode = (value: string) =>
  stripDiacritics(value)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);

const sanitizeWarehousePrefix = (warehouseCode: string) =>
  stripDiacritics(warehouseCode)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8) || 'WH';

export const generateLocationCode = (
  warehouseCode: string,
  description: string,
  existingCodes: Iterable<string> = [],
) => {
  const prefix = sanitizeWarehousePrefix(warehouseCode);
  const base = sanitizeForCode(description) || 'LOC';
  const taken = new Set<string>(
    Array.from(existingCodes, (code) => code.trim().toUpperCase()).filter((code) => code.length > 0),
  );

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const candidate = `${prefix}-${base}${suffix}`;
    const normalizedCandidate = candidate.toUpperCase();
    if (!taken.has(normalizedCandidate)) {
      return normalizedCandidate;
    }
  }

  const fallback =
    Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'RANDOM';
  return `${prefix}-${fallback}`;
};

export const formatWarehouseLocationLabel = (warehouseName?: string | null, locationName?: string | null) => {
  const warehouseLabel = warehouseName?.trim() ? warehouseName.trim() : '미지정 창고';
  const locationLabel = locationName?.trim() ? locationName.trim() : '미지정 위치';
  return `${warehouseLabel} > ${locationLabel}`;
};
