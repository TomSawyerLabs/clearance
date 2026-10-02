import {
  Alert,
  Button,
  Code,
  FileButton,
  Group,
  List,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { type ConfigChange, isApplied } from "../../../shared/config.ts";
import { get, post } from "../../api.ts";
import { Problem, useAction } from "../../components/common.tsx";

const show = (value: unknown) =>
  value === null || value === "" ? "nothing" : JSON.stringify(value);

/** One change in words. */
function Change({ change }: { change: ConfigChange }) {
  switch (change.kind) {
    case "setting":
      return (
        <>
          Setting <Code>{change.key}</Code>: {show(change.from)} becomes{" "}
          {show(change.to)}
        </>
      );
    case "document.create":
      return (
        <>New document “{change.name}” (its text is published separately)</>
      );
    case "document.update":
      return (
        <>
          Document “{change.name}”, <Code>{change.field}</Code>:{" "}
          {show(change.from)} becomes {show(change.to)}
        </>
      );
    case "group.create":
      return <>New group “{change.name}”</>;
    case "group.update":
      return (
        <>
          Group “{change.name}”, <Code>{change.field}</Code>:{" "}
          {show(change.from)} becomes {show(change.to)}
        </>
      );
    case "document.text":
      return (
        <>
          Document “{change.name}”: the published text{" "}
          {change.published
            ? "is not the version"
            : "is missing; it is not the version"}{" "}
          this file was written for. Publish the matching files from the
          Documents page.
        </>
      );
    case "document.unlisted":
      return (
        <>Document “{change.name}” is not in the file. It is left as it is.</>
      );
    case "group.unlisted":
      return (
        <>
          Group “{change.name}” is not in the file. It and its members are left
          as they are.
        </>
      );
  }
}

/**
 * The site's configuration as a file to keep in version control, and a way to
 * apply one back. Nothing is written until the changes have been shown.
 */
export function ConfigFile({ onApplied }: { onApplied(): Promise<void> }) {
  const [pending, setPending] = useState<{
    file: unknown;
    changes: ConfigChange[];
  } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();

  async function download() {
    const config = await get<unknown>("/admin/config");
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(config, null, 2)}\n`], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "clearance.config.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function choose(file: File | null) {
    if (!file) return;
    setDone(null);
    setPending(null);
    await action.run(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not a JSON file.`);
      }
      const plan = await post<{ changes: ConfigChange[] }>(
        "/admin/config/plan",
        parsed,
      );
      setPending({ file: parsed, changes: plan.changes });
    });
  }

  const writes = pending?.changes.filter(isApplied) ?? [];
  const notes = pending?.changes.filter((change) => !isApplied(change)) ?? [];

  return (
    <Paper withBorder p="md">
      <Stack>
        <Stack gap={4}>
          <Title order={4}>Configuration file</Title>
          <Text size="sm" c="dimmed">
            These settings, each document's rules and the list of groups, as one
            file to keep in version control beside the documents' text. It holds
            nothing about people; that is what backups are for.
          </Text>
        </Stack>
        <Group>
          <Button variant="light" onClick={() => action.run(download)}>
            Download configuration
          </Button>
          <FileButton onChange={choose} accept=".json,application/json">
            {(props) => (
              <Button {...props} variant="light" loading={action.busy}>
                Apply a configuration file
              </Button>
            )}
          </FileButton>
        </Group>
        <Problem message={action.error} />
        {done && <Alert color="green">{done}</Alert>}

        {pending && (
          <Stack gap="sm">
            {writes.length === 0 ? (
              <Alert color="green">
                Nothing to change: this site already matches the file.
              </Alert>
            ) : (
              <>
                <Text fw={600}>
                  Applying this file will make these changes:
                </Text>
                <List size="sm" spacing={4}>
                  {writes.map((change, index) => (
                    <List.Item key={index}>
                      <Change change={change} />
                    </List.Item>
                  ))}
                </List>
              </>
            )}
            {notes.length > 0 && (
              <>
                <Text fw={600}>It will not touch these:</Text>
                <List size="sm" spacing={4}>
                  {notes.map((change, index) => (
                    <List.Item key={index}>
                      <Change change={change} />
                    </List.Item>
                  ))}
                </List>
              </>
            )}
            <Group>
              {writes.length > 0 && (
                <Button
                  loading={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await post("/admin/config/apply", pending.file);
                      setPending(null);
                      setDone(
                        `Applied ${writes.length} ${writes.length === 1 ? "change" : "changes"}.`,
                      );
                      await onApplied();
                    })
                  }
                >
                  Apply {writes.length}{" "}
                  {writes.length === 1 ? "change" : "changes"}
                </Button>
              )}
              <Button variant="subtle" onClick={() => setPending(null)}>
                {writes.length > 0 ? "Cancel" : "Close"}
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
