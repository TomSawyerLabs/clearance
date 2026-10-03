import {
  Checkbox,
  Radio,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { type Answer, type Field, isRequired } from "../../shared/document.ts";

/** The input for one question, whichever kind it is. */
export function FieldInput({
  field,
  value,
  problem,
  onChange,
}: {
  field: Field;
  value: Answer | undefined;
  problem: string | undefined;
  onChange(value: Answer): void;
}) {
  const text = typeof value === "string" ? value : "";
  switch (field.type) {
    case "acknowledge":
    case "checkbox":
      return (
        <Checkbox
          label={field.label}
          description={field.help}
          error={problem}
          checked={value === true}
          onChange={(event) => onChange(event.currentTarget.checked)}
          required={field.type === "acknowledge"}
        />
      );
    case "choice":
      return (
        <Radio.Group
          label={field.label}
          description={field.help}
          error={problem}
          value={text}
          onChange={onChange}
          required={field.required}
        >
          <Stack gap="xs" mt="xs">
            {field.options?.map((option) => (
              <Radio key={option} value={option} label={option} />
            ))}
          </Stack>
        </Radio.Group>
      );
    case "multichoice":
      return (
        <Checkbox.Group
          label={field.label}
          description={field.help}
          error={problem}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          required={field.required}
        >
          <Stack gap="xs" mt="xs">
            {field.options?.map((option) => (
              <Checkbox key={option} value={option} label={option} />
            ))}
          </Stack>
        </Checkbox.Group>
      );
    case "longtext":
      return (
        <Textarea
          label={field.label}
          description={field.help}
          error={problem}
          value={text}
          onChange={(event) => onChange(event.currentTarget.value)}
          required={field.required}
          autosize
          minRows={2}
        />
      );
    case "initials":
      return (
        <TextInput
          label={field.label}
          description={field.help ?? "Type your initials."}
          error={problem}
          value={text}
          onChange={(event) =>
            onChange(event.currentTarget.value.toUpperCase())
          }
          required
          maxLength={5}
          maw={160}
          styles={{ input: { fontWeight: 700, letterSpacing: 2 } }}
        />
      );
    case "date":
      return (
        <TextInput
          type="date"
          label={field.label}
          description={field.help}
          error={problem}
          value={text}
          onChange={(event) => onChange(event.currentTarget.value)}
          required={field.required}
          maw={220}
        />
      );
    case "name":
      return (
        <TextInput
          label={field.label}
          description={
            field.help ?? "Type your full name as it is on your account."
          }
          error={problem}
          value={text}
          onChange={(event) => onChange(event.currentTarget.value)}
          required
          autoComplete="name"
        />
      );
    default:
      return (
        <TextInput
          label={field.label}
          description={field.help}
          error={problem}
          value={text}
          onChange={(event) => onChange(event.currentTarget.value)}
          required={isRequired(field)}
        />
      );
  }
}

/** A placed question's answer, read back on a record. */
export function AnswerView({
  field,
  value,
}: {
  field: Field;
  value: Answer | undefined;
}) {
  if (field.type === "acknowledge" || field.type === "checkbox") {
    return (
      <Checkbox label={field.label} checked={value === true} readOnly mb="sm" />
    );
  }
  return (
    <Stack gap={2} mb="sm">
      <Text size="sm" fw={600}>
        {field.label}
      </Text>
      <Text>
        {value === undefined
          ? "(not answered)"
          : Array.isArray(value)
            ? value.join("; ") || "(none)"
            : typeof value === "boolean"
              ? value
                ? "Yes"
                : "No"
              : value || "(left blank)"}
      </Text>
    </Stack>
  );
}
