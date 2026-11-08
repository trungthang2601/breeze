import { useState } from 'react';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { applyLocale } from '@/lib/i18n';
import { saveUserPreferences } from '@/lib/userPreferences';
import { showToast } from '../shared/Toast';

/** One-click English/Vietnamese switch in the header; saves the same user preference as Settings > Appearance. */
export default function LanguageToggle() {
  const { i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const current = (i18n.resolvedLanguage || i18n.language || 'en').startsWith('vi') ? 'vi' : 'en';
  const next = current === 'vi' ? 'en' : 'vi';

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await applyLocale(next);
      await saveUserPreferences({ locale: next }, 'Failed to save language');
    } catch {
      showToast({ type: 'error', message: next === 'vi' ? 'Could not switch to Vietnamese' : 'Không chuyển được sang tiếng Anh' });
    } finally {
      setBusy(false);
    }
  };

  const title = next === 'vi' ? 'Chuyển sang Tiếng Việt' : 'Switch to English';
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      title={title}
      aria-label={title}
      data-testid="language-toggle"
      className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
    >
      <Languages className="h-4 w-4" />
      {current === 'vi' ? 'VI' : 'EN'}
    </button>
  );
}
