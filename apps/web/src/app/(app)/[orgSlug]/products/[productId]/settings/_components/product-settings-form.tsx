'use client';

import * as React from 'react';

import { updateProductSettingsAction } from '@/actions/products.actions';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const LANGUAGES = [
  { value: 'it-IT', label: 'Italiano' },
  { value: 'en-US', label: 'Inglese (US)' },
  { value: 'en-GB', label: 'Inglese (UK)' },
  { value: 'es-ES', label: 'Spagnolo' },
  { value: 'fr-FR', label: 'Francese' },
  { value: 'de-DE', label: 'Tedesco' },
  { value: 'pt-BR', label: 'Portoghese (BR)' },
] as const;

const TIMEZONES = [
  'UTC',
  'Europe/Rome',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Sao_Paulo',
] as const;

/** `0 = domenica`, coerente con `products.active_weekdays` — vedi lo schema. */
const WEEKDAYS = [
  { value: 1, label: 'Lun' },
  { value: 2, label: 'Mar' },
  { value: 3, label: 'Mer' },
  { value: 4, label: 'Gio' },
  { value: 5, label: 'Ven' },
  { value: 6, label: 'Sab' },
  { value: 0, label: 'Dom' },
] as const;

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

interface ProductSettings {
  id: string;
  name: string;
  contentLanguage: string;
  timezone: string;
  publishHour: number;
  activeWeekdays: number[];
  targetWordCountMin: number;
  targetWordCountMax: number;
  autoApproveBrief: boolean;
  autoApproveDraft: boolean;
  approvalTimeoutHours: number | null;
}

export function ProductSettingsForm({ product }: { product: ProductSettings }) {
  const [name, setName] = React.useState(product.name);
  const [contentLanguage, setContentLanguage] = React.useState(product.contentLanguage);
  const [timezone, setTimezone] = React.useState(product.timezone);
  const [publishHour, setPublishHour] = React.useState(product.publishHour);
  const [activeWeekdays, setActiveWeekdays] = React.useState<number[]>(
    product.activeWeekdays,
  );
  const [targetWordCountMin, setTargetWordCountMin] = React.useState(
    product.targetWordCountMin,
  );
  const [targetWordCountMax, setTargetWordCountMax] = React.useState(
    product.targetWordCountMax,
  );
  const [autoApproveBrief, setAutoApproveBrief] = React.useState(product.autoApproveBrief);
  const [autoApproveDraft, setAutoApproveDraft] = React.useState(product.autoApproveDraft);
  const [timeoutEnabled, setTimeoutEnabled] = React.useState(
    product.approvalTimeoutHours !== null,
  );
  const [approvalTimeoutHours, setApprovalTimeoutHours] = React.useState(
    product.approvalTimeoutHours ?? 48,
  );

  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});
  const [savedAt, setSavedAt] = React.useState<number | null>(null);

  function toggleWeekday(day: number) {
    setActiveWeekdays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort(),
    );
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSavedAt(null);

    startTransition(async () => {
      const result = await updateProductSettingsAction({
        productId: product.id,
        name,
        contentLanguage,
        timezone,
        publishHour,
        activeWeekdays,
        targetWordCountMin,
        targetWordCountMax,
        autoApproveBrief,
        autoApproveDraft,
        approvalTimeoutHours: timeoutEnabled ? approvalTimeoutHours : null,
      });

      if (result.ok) {
        setSavedAt(Date.now());
      } else {
        setError(result.message);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-8" noValidate>
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-foreground">Generale</h2>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-name">Nome</Label>
          <Input
            id="settings-name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={fieldErrors.name ? true : undefined}
          />
          <FormError messages={fieldErrors.name} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-language">Lingua dei contenuti</Label>
            <Select
              id="settings-language"
              value={contentLanguage}
              onChange={(event) => setContentLanguage(event.target.value)}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-timezone">Fuso orario</Label>
            <Select
              id="settings-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-6">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Calendario editoriale</h2>
          <p className="mt-1 text-xs text-foreground-muted">
            Quando la pipeline può pubblicare nuovi articoli.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-publish-hour">Orario di pubblicazione</Label>
          <Select
            id="settings-publish-hour"
            value={publishHour}
            onChange={(event) => setPublishHour(Number(event.target.value))}
            className="max-w-[10rem]"
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>
                {String(hour).padStart(2, '0')}:00
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Giorni attivi</Label>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Giorni attivi">
            {WEEKDAYS.map((day) => {
              const active = activeWeekdays.includes(day.value);
              return (
                <button
                  key={day.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleWeekday(day.value)}
                  className={cn(
                    'h-9 rounded-[var(--radius-md)] border px-3 text-sm font-medium transition-colors duration-150',
                    active
                      ? 'border-base-900 bg-base-900 text-base-50'
                      : 'border-border-strong bg-surface text-foreground-muted hover:bg-surface-muted',
                  )}
                >
                  {day.label}
                </button>
              );
            })}
          </div>
          <FormError messages={fieldErrors.activeWeekdays} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-word-min">Parole minime</Label>
            <Input
              id="settings-word-min"
              type="number"
              min={100}
              value={targetWordCountMin}
              onChange={(event) => setTargetWordCountMin(Number(event.target.value))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-word-max">Parole massime</Label>
            <Input
              id="settings-word-max"
              type="number"
              min={100}
              value={targetWordCountMax}
              onChange={(event) => setTargetWordCountMax(Number(event.target.value))}
              aria-invalid={fieldErrors.targetWordCountMax ? true : undefined}
            />
            <FormError messages={fieldErrors.targetWordCountMax} />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-6">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Revisione umana</h2>
          <p className="mt-1 text-xs text-foreground-muted">
            Se disattivi entrambe le approvazioni, la coda di revisione resta
            sempre vuota: la pipeline procede da sola su ogni articolo.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Approva ogni angolo editoriale</p>
            <p className="text-xs text-foreground-muted">
              Prima che un articolo venga scritto, un umano ne conferma l&rsquo;impostazione.
            </p>
          </div>
          <Switch
            checked={!autoApproveBrief}
            onCheckedChange={(checked) => setAutoApproveBrief(!checked)}
            aria-labelledby="settings-approve-brief-label"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Approva ogni bozza</p>
            <p className="text-xs text-foreground-muted">
              Prima della pubblicazione, un umano legge la bozza completa.
            </p>
          </div>
          <Switch
            checked={!autoApproveDraft}
            onCheckedChange={(checked) => setAutoApproveDraft(!checked)}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Timeout di sicurezza</p>
            <p className="text-xs text-foreground-muted">
              Se nessuno approva entro N ore, la pipeline procede comunque —
              evita che le ferie di qualcuno blocchino tutto.
            </p>
          </div>
          <Switch checked={timeoutEnabled} onCheckedChange={setTimeoutEnabled} />
        </div>

        {timeoutEnabled ? (
          <div className="flex flex-col gap-1.5 sm:max-w-[10rem]">
            <Label htmlFor="settings-timeout-hours">Ore di attesa</Label>
            <Input
              id="settings-timeout-hours"
              type="number"
              min={1}
              value={approvalTimeoutHours}
              onChange={(event) => setApprovalTimeoutHours(Number(event.target.value))}
            />
          </div>
        ) : null}
      </section>

      <FormError messages={error} />

      <div className="flex items-center gap-3">
        <Button type="submit" isLoading={isPending} loadingLabel="Salvataggio in corso">
          Salva impostazioni
        </Button>
        {savedAt ? (
          <span role="status" className="text-sm text-success-700">
            Salvato.
          </span>
        ) : null}
      </div>
    </form>
  );
}
