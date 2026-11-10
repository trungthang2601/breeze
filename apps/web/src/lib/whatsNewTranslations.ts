// Fork: localized "What's new" content. Upstream authors WHATS_NEW_ENTRIES in
// English only; this keeps the translations in a separate file so upstream
// merges don't conflict. Any locale/version without a translation falls back
// to the English entry. When merging a new upstream release, add its vi entry
// here (whatsNewTranslations.test.ts fails until the latest release has one).
import type { WhatsNewEntry } from './whatsNew';

export type WhatsNewTranslation = Pick<WhatsNewEntry, 'title' | 'highlights'>;

/** locale (i18next language code) → release version → translated content */
export const WHATS_NEW_TRANSLATIONS: Record<string, Record<string, WhatsNewTranslation>> = {
  vi: {
    '0.127.0': {
      title: 'Duyệt bản sao lưu mọi dung lượng, báo cáo SLA, cảnh báo thông minh hơn và phê duyệt cho AI',
      highlights: [
        'Duyệt, tìm kiếm và khôi phục từng thư mục từ bất kỳ bản chụp sao lưu đám mây nào, kể cả bản rất lớn.',
        'Xem tiến trình sao lưu đang chạy ngay trên trang thiết bị, kèm lý do dễ hiểu khi sao lưu thất bại.',
        'Báo cáo hiệu suất SLA mới, có thể lên lịch và gửi cho khách hàng.',
        'Đặt mặc định cảnh báo lặp lại và tự đóng một lần cho đối tác hoặc cho từng tổ chức.',
        'Nhờ Breeze AI chạy kế hoạch vá lỗi, kiểm tra sao lưu và quản lý cài đặt tổ chức, có bước phê duyệt.',
      ],
    },
  },
};

/** Returns the entry with title/highlights in `language` when a translation exists. */
export function localizeWhatsNew(entry: WhatsNewEntry, language: string | undefined): WhatsNewEntry {
  if (!language) return entry;
  const candidates = [language, language.split('-')[0]!];
  for (const lang of candidates) {
    const tr = WHATS_NEW_TRANSLATIONS[lang]?.[entry.version];
    if (tr) return { ...entry, title: tr.title, highlights: tr.highlights };
  }
  return entry;
}
