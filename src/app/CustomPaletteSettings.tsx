import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Textarea } from "../shared/design-system/ui/Textarea";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import {
  paletteRuntime,
  DEFAULT_CUSTOM_PALETTE,
  type CustomPalette,
  type PaletteColors,
} from "../shared/theme/palette";
import type { Appearance, AppearanceSnapshot } from "../shared/theme/service";
import { AppearancePreview } from "./AppearancePreview";

const fields = ["window", "sidebar", "selection", "accent"] as const;
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function CustomPaletteSettings({
  appearance,
  snapshot,
  active,
}: {
  appearance: Appearance;
  snapshot: AppearanceSnapshot;
  active: boolean;
}) {
  // Draft ownership stays here. External saves never replace a dirty draft;
  // Cancel reveals the latest snapshot, including changes from another window.
  const [draft, setDraft] = useState<CustomPalette | null>(null);
  const [startedFrom, setStartedFrom] = useState<string | null>(null);
  const [mode, setMode] = useState<"light" | "dark">(snapshot.mode);
  const [transfer, setTransfer] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (wasEditing.current && !draft) editButton.current?.focus();
    wasEditing.current = Boolean(draft);
  }, [draft]);
  const parsed = draft ? paletteRuntime.parse(JSON.stringify(draft)) : null;
  const effective = parsed
    ? paletteRuntime.resolve(parsed, mode).effective
    : null;
  const conflict = draft && startedFrom !== JSON.stringify(snapshot.palette);
  const edit = () => {
    setStartedFrom(JSON.stringify(snapshot.palette));
    setDraft(structuredClone(snapshot.palette ?? DEFAULT_CUSTOM_PALETTE));
    setMode(snapshot.mode);
  };
  const change = (field: keyof PaletteColors, value: string) => {
    if (draft)
      setDraft({ ...draft, [mode]: { ...draft[mode], [field]: value } });
  };
  return (
    <div className="mt-section-gap">
      <InlineHeader title="Custom theme" />
      <SettingsGroup layout="form">
        <p className="text-body-sm text-subtle">
          Personal colors saved on this device. Selection colors the selected
          sidebar row. Accent colors Send and your messages; Vibe level still
          controls bubble contrast. Window and Sidebar become subtle tints to
          keep controls readable. Conversation panels keep their neutral colors.
        </p>
        {!draft ? (
          <div className="flex flex-wrap gap-2">
            <Button
              ref={editButton}
              onClick={edit}
              aria-label={snapshot.palette ? "Edit theme" : "Create theme"}
            >
              {snapshot.palette ? "Edit" : "Create"}
            </Button>
            {snapshot.palette && (
              <Button
                aria-label="Reset theme"
                onClick={() => appearance.setPalette(null)}
              >
                Reset
              </Button>
            )}
          </div>
        ) : (
          <>
            <fieldset
              className="m-0 flex flex-wrap gap-2 border-0 p-0"
              aria-label="Palette variant"
            >
              {(["light", "dark"] as const).map((value) => (
                <Button
                  key={value}
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                >
                  {label(value)}
                </Button>
              ))}
            </fieldset>
            {parsed && (
              <AppearancePreview
                palette={parsed}
                mode={mode}
                contrast={snapshot.contrast}
              />
            )}
            {fields.map((field) => {
              const value = draft[mode][field];
              const valid = /^#[0-9a-f]{6}$/i.test(value);
              const adjusted = effective?.[field];
              return (
                <div
                  key={`${mode}-${field}`}
                  className="grid grid-cols-2 gap-2"
                >
                  <Field
                    label={`${label(field)} hex color`}
                    error={
                      valid
                        ? undefined
                        : "Enter a six-digit hex color, such as #663399."
                    }
                    description={
                      valid && adjusted && adjusted !== value.toLowerCase()
                        ? `Effective color: ${adjusted}. Adjusted for readability.`
                        : undefined
                    }
                  >
                    <Input
                      value={value}
                      maxLength={7}
                      spellCheck={false}
                      onChange={(event) => change(field, event.target.value)}
                    />
                  </Field>
                  <Field label={`${label(field)} color picker`}>
                    <Input
                      type="color"
                      value={valid ? value : "#000000"}
                      onChange={(event) => change(field, event.target.value)}
                    />
                  </Field>
                </div>
              );
            })}
            {!parsed && (
              <p role="status" className="text-body-sm text-subtle">
                Fix invalid colors in both Light and Dark before saving.
              </p>
            )}
            {conflict && (
              <p role="status" className="text-body-sm text-subtle">
                The saved theme changed in another window. Your draft is
                retained. Save replaces that theme; Cancel returns to it.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setDraft(null)}>Cancel</Button>
              <Button
                variant="primary"
                aria-label="Save theme"
                disabled={!parsed}
                onClick={() => {
                  if (!parsed) return;
                  appearance.setPalette(parsed);
                  setDraft(null);
                }}
              >
                Save
              </Button>
            </div>
          </>
        )}
        <Field
          label="Palette text"
          description="Copy this versioned Buzz palette text to share it, or paste one to preview before saving."
          error={transferError ?? undefined}
        >
          <Textarea
            aria-label="Palette text"
            value={transfer}
            maxLength={2048}
            onChange={(event) => {
              setTransfer(event.target.value);
              setTransferError(null);
            }}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={draft ? !parsed : !snapshot.palette}
            onClick={() => {
              setTransfer(JSON.stringify(parsed ?? snapshot.palette, null, 2));
              setTransferError(null);
            }}
          >
            Export
          </Button>
          <Button
            onClick={() => {
              const imported = paletteRuntime.parse(transfer);
              if (!imported) {
                setTransferError(
                  "Use a version 1 Buzz palette with six-digit hex colors for both Light and Dark.",
                );
                return;
              }
              setStartedFrom(JSON.stringify(snapshot.palette));
              setDraft(imported);
              setTransferError(null);
            }}
          >
            Import
          </Button>
        </div>
      </SettingsGroup>
      {active && snapshot.paletteError && (
        <ToastNotice
          title="Custom theme wasn’t saved"
          description={snapshot.paletteError}
        >
          <Button onClick={() => appearance.setPalette(snapshot.palette)}>
            Retry
          </Button>
        </ToastNotice>
      )}
    </div>
  );
}
