interface GlobalPreferenceNumberInputProps {
  label: string;
  value?: number;
  min?: number;
  max?: number;
  step: number;
  onChange: (value: number | undefined) => void;
}

export function GlobalPreferenceNumberInput({ label, value, min, max, step, onChange }: GlobalPreferenceNumberInputProps) {
  return (
    <label className="chat-preference-field">
      {label}
      <input
        className="ui-input chat-preference-number-input"
        aria-label={`全局 ${label}`}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value ?? ""}
        onChange={(event) => {
          const inputValue = event.target.value.trim();
          onChange(inputValue ? Number(inputValue) : undefined);
        }}
      />
    </label>
  );
}
