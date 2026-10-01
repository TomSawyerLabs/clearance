import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { useParams } from "react-router";
import { type Field, fieldsSchema } from "../../../shared/document.ts";
import { api, type ClearanceDto, post, type VersionDto } from "../../api.ts";
import { Loaded, Problem, useAction } from "../../components/common.tsx";
import { DocumentView } from "../../components/DocumentView.tsx";
import { useFormat, useLoad, useSite } from "../../site.tsx";

const FIELD_TYPES: { value: Field["type"]; label: string }[] = [
  { value: "text", label: "Short answer" },
  { value: "longtext", label: "Long answer" },
  { value: "choice", label: "Pick one option" },
  { value: "checkbox", label: "Optional tick box" },
  { value: "acknowledge", label: "Tick box that must be ticked" },
];

function keyFrom(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^[^a-z]+|_+$/g, "")
      .slice(0, 32) || "question";
  let key = base;
  for (let n = 2; taken.includes(key); n++) key = `${base}_${n}`;
  return key;
}

/** The questions asked alongside the document. Keys are derived from labels. */
function FieldsEditor({
  fields,
  onChange,
}: {
  fields: Field[];
  onChange(fields: Field[]): void;
}) {
  const { state } = useSite();
  const [pasting, setPasting] = useState(false);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const update = (index: number, patch: Partial<Field>) =>
    onChange(
      fields.map((field, i) => (i === index ? { ...field, ...patch } : field)),
    );

  return (
    <Stack gap="sm">
      <Stack gap={2}>
        <Title order={4}>Questions</Title>
        <Text size="sm" c="dimmed">
          Asked on the signing page and printed, with the answers, on the signed
          record.
        </Text>
      </Stack>
      {fields.map((field, index) => (
        <Paper key={index} withBorder p="sm">
          <Stack gap="xs">
            <TextInput
              label="Question or statement"
              value={field.label}
              onChange={(event) =>
                update(index, { label: event.currentTarget.value })
              }
              required
            />
            <Group align="flex-end">
              <NativeSelect
                label="Answered with"
                data={FIELD_TYPES}
                value={field.type}
                onChange={(event) =>
                  update(index, {
                    type: event.currentTarget.value as Field["type"],
                  })
                }
              />
              {state.site.guardiansEnabled && (
                <NativeSelect
                  label="Answered by"
                  data={[
                    { value: "primary", label: "The adult signing" },
                    { value: "minor", label: "The student, when under age" },
                  ]}
                  value={field.audience ?? "primary"}
                  onChange={(event) =>
                    update(index, {
                      audience: event.currentTarget.value as Field["audience"],
                    })
                  }
                />
              )}
              {["text", "longtext", "choice"].includes(field.type) && (
                <Checkbox
                  label="Must be answered"
                  checked={field.required ?? false}
                  onChange={(event) =>
                    update(index, { required: event.currentTarget.checked })
                  }
                  mb={8}
                />
              )}
            </Group>
            {field.type === "choice" && (
              <Textarea
                label="Options, one per line"
                value={(field.options ?? []).join("\n")}
                onChange={(event) =>
                  update(index, {
                    options: event.currentTarget.value.split("\n"),
                  })
                }
                autosize
                minRows={2}
              />
            )}
            <Group>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
              >
                Remove this question
              </Button>
            </Group>
          </Stack>
        </Paper>
      ))}
      <Group>
        <Button
          variant="light"
          size="xs"
          onClick={() =>
            onChange([...fields, { key: "", label: "", type: "text" }])
          }
        >
          Add a question
        </Button>
        <Button
          variant="subtle"
          size="xs"
          onClick={() => {
            // Start from the questions as they stand now, keys filled in.
            setJson(JSON.stringify(tidy(fields), null, 2));
            setJsonError(null);
            setPasting(!pasting);
          }}
        >
          {pasting ? "Cancel pasting" : "Paste questions as JSON"}
        </Button>
      </Group>
      {pasting && (
        <Stack gap="xs">
          <Textarea
            label="Questions as JSON"
            description="Replaces the questions above. Useful for keeping a document's questions in a file beside its text."
            value={json}
            onChange={(event) => setJson(event.currentTarget.value)}
            autosize
            minRows={6}
            maxRows={20}
            error={jsonError}
            styles={{
              input: {
                fontFamily: "var(--mantine-font-family-monospace)",
                fontSize: 13,
              },
            }}
          />
          <Group>
            <Button
              size="xs"
              onClick={() => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(json);
                } catch {
                  setJsonError("That is not valid JSON.");
                  return;
                }
                const checked = fieldsSchema.safeParse(parsed);
                if (!checked.success) {
                  const issue = checked.error.issues[0];
                  setJsonError(
                    `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "not valid"}`,
                  );
                  return;
                }
                onChange(checked.data);
                setJsonError(null);
                setPasting(false);
              }}
            >
              Use these questions
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

/** Blank lines out of options, and a key for every question that lacks one. */
function tidy(fields: Field[]): Field[] {
  const keys: string[] = fields.map((field) => field.key).filter(Boolean);
  return fields.map((field) => {
    const key = field.key || keyFrom(field.label, keys);
    if (!field.key) keys.push(key);
    return {
      ...field,
      key,
      label: field.label.trim(),
      options:
        field.type === "choice"
          ? (field.options ?? []).map((option) => option.trim()).filter(Boolean)
          : undefined,
    };
  });
}

function Editor({
  clearance,
  current,
  onPublished,
}: {
  clearance: ClearanceDto;
  current: VersionDto | undefined;
  onPublished(): Promise<void>;
}) {
  const [title, setTitle] = useState(current?.title ?? clearance.name);
  const [body, setBody] = useState(current?.body ?? "");
  const [fields, setFields] = useState<Field[]>(current?.fields ?? []);
  const [supersedes, setSupersedes] = useState(true);
  const [view, setView] = useState("write");
  const action = useAction();
  const unchanged =
    current !== undefined &&
    title === current.title &&
    body === current.body &&
    JSON.stringify(tidy(fields)) === JSON.stringify(current.fields);

  return (
    <Stack>
      <Title order={3}>{current ? "Edit the text" : "Write the text"}</Title>
      <TextInput
        label="Title"
        description="Printed at the top of the signing page and the signed record."
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
        required
      />
      <Group justify="space-between" align="flex-end">
        <Text size="sm" c="dimmed">
          Written in Markdown: # for headings, **bold**, *italic*, numbered and
          bulleted lists.
        </Text>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={setView}
          data={[
            { value: "write", label: "Write" },
            { value: "preview", label: "Preview" },
          ]}
        />
      </Group>
      {view === "write" ? (
        <Textarea
          aria-label="Document text"
          value={body}
          onChange={(event) => setBody(event.currentTarget.value)}
          autosize
          minRows={14}
          maxRows={40}
          styles={{
            input: {
              fontFamily: "var(--mantine-font-family-monospace)",
              fontSize: 13,
            },
          }}
        />
      ) : (
        <Paper withBorder p="md">
          {body.trim() ? (
            <DocumentView markdown={body} />
          ) : (
            <Text c="dimmed">Nothing written yet.</Text>
          )}
        </Paper>
      )}

      <FieldsEditor fields={fields} onChange={setFields} />

      {current && (
        <Switch
          label="Everyone who has signed must sign again"
          description="Leave this on when the meaning changes. Turn it off only for a correction, such as a typo, that changes nothing anyone agreed to."
          checked={supersedes}
          onChange={(event) => setSupersedes(event.currentTarget.checked)}
        />
      )}
      <Alert color="blue">
        Publishing is permanent. A published version cannot be edited, because
        people sign it; a change is always a new version.
      </Alert>
      <Problem message={action.error} />
      <Group>
        <Button
          loading={action.busy}
          disabled={!title.trim() || !body.trim() || unchanged}
          onClick={() =>
            action.run(async () => {
              await post(`/clearances/${clearance.id}/versions`, {
                title,
                body,
                fields: tidy(fields),
                supersedes: current ? supersedes : true,
              });
              await onPublished();
            })
          }
        >
          Publish version {(current?.version ?? 0) + 1}
        </Button>
        {unchanged && (
          <Text size="sm" c="dimmed">
            Nothing has changed since version {current.version}.
          </Text>
        )}
      </Group>
    </Stack>
  );
}

function Options({
  clearance,
  reload,
}: {
  clearance: ClearanceDto;
  reload(): Promise<void>;
}) {
  const { state } = useSite();
  const [name, setName] = useState(clearance.name);
  const [requiredForAll, setRequiredForAll] = useState(
    clearance.requiredForAll,
  );
  const [validityDays, setValidityDays] = useState<number | null>(
    clearance.validityDays,
  );
  const [minorPolicy, setMinorPolicy] = useState(clearance.minorPolicy);
  const action = useAction();
  const save = (patch: Record<string, unknown>) =>
    action.run(async () => {
      await api("PATCH", `/clearances/${clearance.id}`, patch);
      await reload();
    });

  return (
    <Paper withBorder p="md">
      <Stack>
        <Title order={4}>Rules</Title>
        <TextInput
          label="Name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          required
        />
        <Switch
          label="Required of everyone in a group"
          description="Group managers see who has not signed a required document. People in no group, such as a parent who only signs for a child, can sign it but are not chased."
          checked={requiredForAll}
          onChange={(event) => setRequiredForAll(event.currentTarget.checked)}
        />
        <NumberInput
          label="Valid for (days)"
          description="Leave empty for no expiry. 365 makes everyone sign again each year."
          value={validityDays ?? ""}
          onChange={(value) =>
            setValidityDays(typeof value === "number" ? value : null)
          }
          min={1}
          max={3650}
          allowDecimal={false}
          maw={260}
        />
        {state.site.guardiansEnabled && (
          <NativeSelect
            label="For someone under age, who signs?"
            data={[
              { value: "guardian", label: "A parent or guardian" },
              {
                value: "guardian_and_minor",
                label: "A parent or guardian, and the student too",
              },
            ]}
            value={minorPolicy}
            onChange={(event) =>
              setMinorPolicy(
                event.currentTarget.value as ClearanceDto["minorPolicy"],
              )
            }
            maw={420}
          />
        )}
        <Problem message={action.error} />
        <Group>
          <Button
            variant="light"
            loading={action.busy}
            disabled={!name.trim()}
            onClick={() =>
              save({ name, requiredForAll, validityDays, minorPolicy })
            }
          >
            Save rules
          </Button>
          <Button
            variant="subtle"
            color="gray"
            disabled={action.busy}
            onClick={() => save({ archived: !clearance.archived })}
          >
            {clearance.archived
              ? "Restore this document"
              : "Archive this document"}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function ClearancePage() {
  const { id } = useParams();
  const format = useFormat();
  const clearances = useLoad<ClearanceDto[]>("/clearances");
  const versions = useLoad<VersionDto[]>(`/clearances/${id}/versions`);
  const reload = async () => {
    await Promise.all([clearances.reload(), versions.reload()]);
  };

  return (
    <Loaded
      data={clearances.data && versions.data}
      error={clearances.error ?? versions.error}
    >
      {() => {
        const clearance = clearances.data!.find((entry) => entry.id === id);
        if (!clearance)
          return <Problem message="That document does not exist." />;
        const history = versions.data!;
        return (
          <Stack gap="xl">
            <Group gap="xs">
              <Title order={2}>{clearance.name}</Title>
              {clearance.archived && <Badge color="gray">Archived</Badge>}
            </Group>
            {/* Remount on publish so the editor starts from the new current version. */}
            <Editor
              key={history[0]?.id ?? "new"}
              clearance={clearance}
              current={history[0]}
              onPublished={reload}
            />
            <Options
              key={JSON.stringify(clearance)}
              clearance={clearance}
              reload={reload}
            />
            {history.length > 0 && (
              <Stack gap="xs">
                <Title order={4}>Published versions</Title>
                {history.map((version) => (
                  <Text key={version.id} size="sm">
                    Version {version.version}, published{" "}
                    {format.dateTime(version.publishedAt)}
                    {version.version > 1 && !version.supersedes
                      ? " (a correction; earlier signatures stayed valid)"
                      : ""}
                  </Text>
                ))}
              </Stack>
            )}
          </Stack>
        );
      }}
    </Loaded>
  );
}
