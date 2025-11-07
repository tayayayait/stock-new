import { createPartner, listPartners, updatePartner, type Partner, type PartnerType } from '../services/orders';

export interface PartnerCsvPreviewRow {
  rowNumber: number;
  action: 'create' | 'update' | 'error';
  messages: string[];
  payload?: {
    type: PartnerType;
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    notes?: string;
  };
  existingId?: string;
}

export interface PartnerCsvPreviewSummary {
  total: number;
  createCount: number;
  updateCount: number;
  errorCount: number;
}

export interface PartnerCsvPreviewResult {
  rows: PartnerCsvPreviewRow[];
  summary: PartnerCsvPreviewSummary;
}

export interface PartnerCsvCommitResult {
  created: number;
  updated: number;
  failed: Array<{ rowNumber: number; message: string }>;
}

const REQUIRED_HEADERS = ['type', 'name'] as const;
const OPTIONAL_HEADERS = ['phone', 'email', 'address', 'notes'] as const;
const ALLOWED_HEADERS = new Set<string>([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);

const TYPE_ALIASES: Record<string, PartnerType> = {
  supplier: 'SUPPLIER',
  공급업체: 'SUPPLIER',
  vendor: 'SUPPLIER',
  공급사: 'SUPPLIER',
  customer: 'CUSTOMER',
  고객사: 'CUSTOMER',
  buyer: 'CUSTOMER',
};

const HEADER_ALIASES: Record<string, string> = {
  type: 'type',
  종류: 'type',
  name: 'name',
  거래처명: 'name',
  phone: 'phone',
  연락처: 'phone',
  email: 'email',
  이메일: 'email',
  address: 'address',
  주소: 'address',
  notes: 'notes',
  비고: 'notes',
};

const HEADER_DISPLAY_NAMES: Record<string, string> = {
  type: '종류',
  name: '거래처명',
  phone: '연락처',
  email: '이메일',
  address: '주소',
  notes: '비고',
};

const parseCsvLine = (line: string): string[] => {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
};

const normalizeHeader = (header: string): string => header.trim().toLowerCase();

const normalizeType = (value: string): PartnerType | null => {
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  const direct = raw.toUpperCase();
  if (direct === 'SUPPLIER' || direct === 'CUSTOMER') {
    return direct as PartnerType;
  }
  const alias = TYPE_ALIASES[raw.toLowerCase()];
  return alias ?? null;
};

const normalizeText = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const buildPartnerKey = (type: PartnerType, name: string): string => `${type}::${name.toLowerCase()}`;

export const downloadPartnerCsvTemplate = async (): Promise<Blob> => {
  const headers = ['종류', '거래처명', '연락처', '이메일', '주소', '비고'];
  const sampleRows = [
    ['SUPPLIER', '한빛식품', '02-1234-5678', 'sales@hanbitfood.co.kr', '서울특별시 성동구 성수이로 77', '과일 공급'],
    ['CUSTOMER', '프레시몰 온라인', '02-444-0020', 'ops@freshmall.co.kr', '서울특별시 송파구 위례성대로 55', '온라인몰'],
  ];
  const headerLine = headers.join(',');
  const body = sampleRows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  return new Blob(['\uFEFF', headerLine, '\n', body], { type: 'text/csv;charset=utf-8' });
};

export async function buildExistingPartnerMap(): Promise<Map<string, Partner>> {
  const existing = await listPartners({ includeSample: true });
  const map = new Map<string, Partner>();
  existing.forEach((partner) => {
    const key = buildPartnerKey(partner.type, partner.name);
    if (!map.has(key)) {
      map.set(key, partner);
    }
  });
  return map;
}

export function parsePartnerCsv(content: string, existingMap: Map<string, Partner>): PartnerCsvPreviewResult {
  const sanitized = content.replace(/^\uFEFF/, '');
  if (!sanitized.trim()) {
    return {
      rows: [],
      summary: {
        total: 0,
        createCount: 0,
        updateCount: 0,
        errorCount: 1,
      },
    };
  }

  const lines = sanitized.split(/\r?\n/);
  const headerLine = lines[0] ?? '';
  const rawHeaders = parseCsvLine(headerLine);

  const canonicalHeaders: string[] = [];
  const headerIndexMap = new Map<number, string>();
  const unknownHeaders: string[] = [];

  rawHeaders.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const canonical = HEADER_ALIASES[normalized] ?? (ALLOWED_HEADERS.has(normalized) ? normalized : null);
    if (canonical) {
      canonicalHeaders.push(canonical);
      headerIndexMap.set(index, canonical);
    } else {
      unknownHeaders.push(header.trim() || `(열 ${index + 1})`);
    }
  });

  const missingHeaders = REQUIRED_HEADERS.filter((required) => !canonicalHeaders.includes(required));
  if (missingHeaders.length > 0) {
    const missingLabels = missingHeaders.map((header) => HEADER_DISPLAY_NAMES[header] ?? header);
    const message = `필수 헤더가 누락되었습니다: ${missingLabels.join(', ')}`;
    return {
      rows: [
        {
          rowNumber: 1,
          action: 'error',
          messages: [message],
        },
      ],
      summary: {
        total: 0,
        createCount: 0,
        updateCount: 0,
        errorCount: 1,
      },
    };
  }

  const headerErrors = unknownHeaders.map((header) => `알 수 없는 헤더 '${header}'를 삭제하거나 지원되는 항목으로 변경해주세요.`);

  const seenKeys = new Set<string>();
  const rows: PartnerCsvPreviewRow[] = [];
  let createCount = 0;
  let updateCount = 0;
  let errorCount = headerErrors.length > 0 ? 1 : 0;

  if (headerErrors.length > 0) {
    rows.push({
      rowNumber: 1,
      action: 'error',
      messages: headerErrors,
    });
  }

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const values = parseCsvLine(line);
    if (values.every((value) => value.trim().length === 0)) {
      continue;
    }
    const record: Record<string, string> = {};

    headerIndexMap.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });

    const rowNumber = i + 1;
    const messages: string[] = [];

    const rawType = record.type ?? '';
    const normalizedType = normalizeType(rawType);
    if (!normalizedType) {
      messages.push('종류 값이 올바르지 않습니다. SUPPLIER 또는 CUSTOMER를 입력해주세요.');
    }

    const name = normalizeText(record.name);
    if (!name) {
      messages.push('거래처명 값이 비어 있습니다.');
    }

    if (!normalizedType || !name) {
      rows.push({
        rowNumber,
        action: 'error',
        messages,
      });
      errorCount += 1;
      continue;
    }

    const key = buildPartnerKey(normalizedType, name);
    if (seenKeys.has(key)) {
      rows.push({
        rowNumber,
        action: 'error',
        messages: ['동일한 거래처가 CSV 내에 중복되었습니다. 종류와 거래처명 조합이 중복되지 않도록 수정하세요.'],
      });
      errorCount += 1;
      continue;
    }
    seenKeys.add(key);

    const phone = normalizeText(record.phone);
    const email = normalizeText(record.email);
    const address = normalizeText(record.address);
    const notes = normalizeText(record.notes);

    if (messages.length > 0) {
      rows.push({
        rowNumber,
        action: 'error',
        messages,
      });
      errorCount += 1;
      continue;
    }

    const existing = existingMap.get(key);
    const payload: NonNullable<PartnerCsvPreviewRow['payload']> = {
      type: normalizedType,
      name,
      phone,
      email,
      address,
      notes,
    };

    const action: PartnerCsvPreviewRow['action'] = existing ? 'update' : 'create';
    if (action === 'create') {
      createCount += 1;
    } else {
      updateCount += 1;
    }

    rows.push({
      rowNumber,
      action,
      messages: [],
      payload,
      existingId: existing?.id,
    });
  }

  const summary: PartnerCsvPreviewSummary = {
    total: rows.length,
    createCount,
    updateCount,
    errorCount,
  };

  return { rows, summary };
}

const buildUpdatePayload = (row: PartnerCsvPreviewRow['payload']) => {
  if (!row) {
    return null;
  }
  return {
    type: row.type,
    name: row.name,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    address: row.address ?? undefined,
    notes: row.notes ?? undefined,
  };
};

export async function commitPartnerCsv(preview: PartnerCsvPreviewResult): Promise<PartnerCsvCommitResult> {
  const result: PartnerCsvCommitResult = {
    created: 0,
    updated: 0,
    failed: [],
  };

  for (const row of preview.rows) {
    if (row.action === 'error' || !row.payload) {
      continue;
    }

    try {
      if (row.action === 'create') {
        await createPartner({
          type: row.payload.type,
          name: row.payload.name,
          phone: row.payload.phone,
          email: row.payload.email,
          address: row.payload.address,
          notes: row.payload.notes,
        });
        result.created += 1;
      } else if (row.action === 'update') {
        if (!row.existingId) {
          throw new Error('기존 거래처 ID를 찾을 수 없습니다.');
        }
        const updatePayload = buildUpdatePayload(row.payload);
        if (!updatePayload) {
          continue;
        }
        await updatePartner({
          id: row.existingId,
          type: updatePayload.type,
          name: updatePayload.name,
          phone: updatePayload.phone ?? null,
          email: updatePayload.email ?? null,
          address: updatePayload.address ?? null,
          notes: updatePayload.notes ?? null,
        });
        result.updated += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.';
      result.failed.push({ rowNumber: row.rowNumber, message });
    }
  }

  return result;
}
