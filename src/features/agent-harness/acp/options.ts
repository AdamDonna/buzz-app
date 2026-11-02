// ACP session config options: the harness's whole option state, read from
// `configOptions` on session responses and `config_option_update`.
import type { ConfigOption, ConfigValue, OptionState } from "./types";

export const NO_OPTIONS: OptionState = { options: [] };

/** The state `raw` describes, groups flattened; `NO_OPTIONS` when it isn't a list. */
export function optionState(raw: unknown): OptionState {
  if (!Array.isArray(raw)) return NO_OPTIONS;
  const options = raw.flatMap((entry): ConfigOption[] => {
    const option = record(entry);
    if (!option || typeof option.id !== "string") return [];
    return [
      {
        id: option.id,
        name: typeof option.name === "string" ? option.name : option.id,
        ...(typeof option.category === "string"
          ? { category: option.category }
          : {}),
        type: typeof option.type === "string" ? option.type : "",
        currentValue:
          typeof option.currentValue === "string" ? option.currentValue : "",
        options: values(option.options),
      },
    ];
  });
  return {
    options,
    ...only(options, "model", "model"),
    ...only(options, "thought_level", "effort"),
  };
}

/** Whether `value` is one the control offers. */
export const offers = (control: ConfigOption | undefined, value: string) =>
  !!control?.options.some((option) => option.value === value);

/** The one usable select in `category`, under `field`; none when there are
 * none or several. */
function only(
  options: readonly ConfigOption[],
  category: string,
  field: "model" | "effort",
) {
  const usable = options.filter(
    (option) => option.category === category && option.type === "select",
  );
  return usable.length === 1 ? { [field]: usable[0] } : {};
}

function values(raw: unknown): ConfigValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ConfigValue[] => {
    const value = record(entry);
    if (!value) return [];
    // A group carries its own `options`.
    if (Array.isArray(value.options)) return values(value.options);
    if (typeof value.value !== "string") return [];
    return [
      {
        value: value.value,
        name: typeof value.name === "string" ? value.name : value.value,
        ...(typeof value.description === "string"
          ? { description: value.description }
          : {}),
      },
    ];
  });
}

const record = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
