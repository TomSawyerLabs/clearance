import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  FileButton,
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
import { Fragment, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import {
  checkMarkers,
  type Field,
  fieldsSchema,
  type Variables,
} from "../../../shared/document.ts";
import {
  documentFingerprint,
  fromMarkdownFile,
  resolveDocument,
  toFieldsFile,
  toMarkdownFile,
} from "../../../shared/documentFile.ts";
import {
  api,
  type ClearanceDto,
  post,
  type Settings,
  type VersionDto,
} from "../../api.ts";
import { Loaded, Problem, useAction } from "../../components/common.tsx";
import { DocumentView } from "../../components/DocumentView.tsx";
import { useFormat, useLoad, useSite } from "../../site.tsx";

const FIELD_TYPES: { value: Field["type"]; label: string }[] = [
  { value: "text", label: "Short answer" },
  { value: "longtext", label: "Long answer" },
  { value: "choice", label: "Pick one option" },
  { value: "multichoice", label: "Tick any of the options" },
  { value: "checkbox", label: "Optional tick box" },
  { value: "acknowledge", label: "Tick box that must be ticked" },
  { value: "initials", label: "Initials" },
  { value: "date", label: "A date" },
  { value: "name", label: "The signer types their name" },
];

/** Kinds where "required" is a choice; the others are always required or always optional. */
const OPTIONAL_KINDS: Field["type"][] = [
  "text",
  "longtext",
  "choice",
  "multichoice",
  "date",
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
          record. They follow the text, unless the text places one with{" "}
          <Code>{"{{question:key}}"}</Code> on a line of its own, for instance
          initials beside a clause.
        </Text>
      </Stack>
      {fields.map((field, index) => (
        <Paper key={index} withBorder p="sm">
          <Stack gap="xs">
            <TextInput
              label="Question or statement"
              description={
                field.key ? (
                  <>
                    Key <Code>{field.key}</Code>
                  </>
                ) : (
                  "The key, for placing it in the text, is made from this wording."
                )
              }
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
              {OPTIONAL_KINDS.includes(field.type) && (
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
            {(field.type === "choice" || field.type === "multichoice") && (
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
        field.type === "choice" || field.type === "multichoice"
          ? (field.options ?? []).map((option) => option.trim()).filter(Boolean)
          : undefined,
    };
  });
}

function Editor({
  clearance,
  current,
  variables,
  onPublished,
}: {
  clearance: ClearanceDto;
  current: VersionDto | undefined;
  /** The site's variables, which `{{name}}` in the text stands for. */
  variables: Variables;
  onPublished(): Promise<void>;
}) {
  const [title, setTitle] = useState(current?.title ?? clearance.name);
  const [body, setBody] = useState(current?.body ?? "");
  const [fields, setFields] = useState<Field[]>(current?.fields ?? []);
  const [supersedes, setSupersedes] = useState(true);
  const [view, setView] = useState("write");
  const action = useAction();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  // What publishing would store: the variables filled in. The preview shows
  // it, and the fingerprint is taken over it, as the server's will be.
  const resolved = useMemo(
    () => resolveDocument({ title, body, fields: tidy(fields) }, variables),
    [title, body, fields, variables],
  );
  const markerProblems = useMemo(
    () => checkMarkers(resolved.content.body, resolved.content.fields),
    [resolved],
  );

  // The same fingerprint the server will record on publishing, and the one
  // `clearance hash` prints for the files, so a draft can be checked first.
  useEffect(() => {
    let live = true;
    documentFingerprint(resolved.content).then(
      (value) => live && setFingerprint(value),
      // Not fingerprintable yet, e.g. a question with no wording.
      () => live && setFingerprint(null),
    );
    return () => {
      live = false;
    };
  }, [resolved]);
  const unchanged = current !== undefined && fingerprint === current.bodyHash;
  const blocked = resolved.missing.length > 0 || markerProblems.length > 0;

  /** Takes the text from a `.md` file and the questions from a `.json` file. */
  async function load(files: File[]) {
    setLoadError(null);
    try {
      for (const file of files) {
        const text = await file.text();
        if (file.name.toLowerCase().endsWith(".json")) {
          const parsed = fieldsSchema.safeParse(JSON.parse(text));
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new Error(
              `${file.name}: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "is not a list of questions"}`,
            );
          }
          setFields(parsed.data);
        } else {
          const document = fromMarkdownFile(text);
          if (document.title) setTitle(document.title);
          setBody(document.body);
        }
      }
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }

  return (
    <Stack>
      <Title order={3}>{current ? "Edit the text" : "Write the text"}</Title>
      <Group>
        <FileButton onChange={load} accept=".md,.markdown,.txt,.json" multiple>
          {(props) => (
            <Button {...props} variant="light" size="xs">
              Load from files
            </Button>
          )}
        </FileButton>
        <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 220 }}>
          A Markdown file whose first line is “# Title”, and optionally a JSON
          file of questions. Choose both at once.
        </Text>
      </Group>
      <Problem message={loadError} />
      <TextInput
        label="Title"
        description="Printed at the top of the signing page and the signed record."
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
        required
      />
      <Group justify="space-between" align="flex-end">
        <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 220 }}>
          Written in Markdown: # for headings, **bold**, *italic*, numbered and
          bulleted lists. <Code>{"{{legal_entity}}"}</Code> is filled in from
          the variables in Settings when a version is published.
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
            <DocumentView
              markdown={resolved.content.body}
              fields={resolved.content.fields}
            />
          ) : (
            <Text c="dimmed">Nothing written yet.</Text>
          )}
        </Paper>
      )}
      {resolved.missing.length > 0 && (
        <Alert color="yellow" title="Variables without a value">
          The text uses{" "}
          {resolved.missing.map((name, index) => (
            <Fragment key={name}>
              {index > 0 && ", "}
              <Code>{`{{${name}}}`}</Code>
            </Fragment>
          ))}
          . Set {resolved.missing.length === 1 ? "it" : "them"} in Settings
          before publishing.
        </Alert>
      )}
      {markerProblems.length > 0 && (
        <Alert color="yellow" title="Placed questions">
          {markerProblems.join(" ")}
        </Alert>
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
          disabled={!title.trim() || !body.trim() || unchanged || blocked}
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
      {fingerprint && !unchanged && (
        <Fingerprint label="Fingerprint of this draft" value={fingerprint} />
      )}
    </Stack>
  );
}

/** A document's SHA-256, shown whole: its job is to be compared. */
function Fingerprint({ label, value }: { label: string; value: string }) {
  return (
    <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
      {label}: <Code>{value}</Code>
    </Text>
  );
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** A published version, with the files to keep in version control. */
function PublishedVersion({
  clearance,
  version,
}: {
  clearance: ClearanceDto;
  version: VersionDto;
}) {
  const format = useFormat();
  const slug =
    clearance.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "document";
  return (
    <Paper withBorder p="sm">
      <Stack gap={6}>
        <Text size="sm">
          <strong>Version {version.version}</strong>, published{" "}
          {format.dateTime(version.publishedAt)}
          {version.version > 1 && !version.supersedes
            ? " (a correction; earlier signatures stayed valid)"
            : ""}
        </Text>
        <Fingerprint label="Fingerprint" value={version.bodyHash} />
        <Group gap="xs">
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() =>
              download(
                `${slug}.md`,
                toMarkdownFile(version.title, version.body),
              )
            }
          >
            Download the text (.md)
          </Button>
          {version.fields.length > 0 && (
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() =>
                download(`${slug}.fields.json`, toFieldsFile(version.fields))
              }
            >
              Download the questions (.json)
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
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
        {state.site.guardiansEnabled && clearance.kind === "release" && (
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
  const settings = useLoad<Settings>("/admin/settings");
  const reload = async () => {
    await Promise.all([clearances.reload(), versions.reload()]);
  };

  return (
    <Loaded
      data={clearances.data && versions.data && settings.data}
      error={clearances.error ?? versions.error ?? settings.error}
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
              {clearance.kind === "certification" && (
                <Badge color="grape">Certification</Badge>
              )}
              {clearance.archived && <Badge color="gray">Archived</Badge>}
            </Group>
            {clearance.kind === "certification" && (
              <Text size="sm" c="dimmed">
                A mentor signs this document to certify a person: a manager of
                one of their groups, or an administrator. Write it as what the
                mentor is attesting to, and ask the mentor the questions.
              </Text>
            )}
            {/* Remount on publish so the editor starts from the new current version. */}
            <Editor
              key={history[0]?.id ?? "new"}
              clearance={clearance}
              current={history[0]}
              variables={settings.data!.variables}
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
                <Text size="sm" c="dimmed">
                  To check that files in version control are what was published,
                  run{" "}
                  <Code>
                    clearance hash FILE.md FIELDS.json --config
                    clearance.config.json
                  </Code>{" "}
                  on them and compare the fingerprint. The downloads below are
                  the text as published, with the variables filled in.
                </Text>
                {history.map((version) => (
                  <PublishedVersion
                    key={version.id}
                    clearance={clearance}
                    version={version}
                  />
                ))}
              </Stack>
            )}
          </Stack>
        );
      }}
    </Loaded>
  );
}
