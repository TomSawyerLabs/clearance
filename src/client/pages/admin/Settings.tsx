import {
  Button,
  Code,
  Group,
  Select,
  NumberInput,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import type { Variables } from "../../../shared/document.ts";
import { api, type Settings } from "../../api.ts";
import { Loaded, Problem, useAction } from "../../components/common.tsx";
import { ConfigFile } from "./ConfigFile.tsx";
import { useLoad, useSite } from "../../site.tsx";

type AdminSettings = Settings & { originFromEnvironment: boolean };

/** Every zone the browser knows, plus the current value in case it is not among them. */
function timeZones(current: string): string[] {
  const known =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return [...new Set(["UTC", current, ...known])].sort();
}

/**
 * Facts documents refer to as `{{name}}`. Kept as a list of rows while
 * editing, so that a key can be typed letter by letter without the entry
 * jumping around; turned back into an object on every change.
 */
function VariablesEditor({
  variables,
  onChange,
}: {
  variables: Variables;
  onChange(variables: Variables): void;
}) {
  const [rows, setRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(variables).map(([key, value]) => ({ key, value })),
  );
  const update = (next: { key: string; value: string }[]) => {
    setRows(next);
    onChange(
      Object.fromEntries(
        next
          .filter((row) => row.key.trim())
          .map((row) => [row.key.trim(), row.value]),
      ),
    );
  };
  return (
    <Stack gap="sm">
      <Stack gap={2}>
        <Title order={4}>Variables</Title>
        <Text size="sm" c="dimmed">
          Facts about the organization that documents refer to, so the wording
          can say <Code>{"{{legal_entity}}"}</Code> and stay the same when a
          fact changes. Filled in when a version is published. Keys are
          lowercase letters, digits and underscores.
        </Text>
      </Stack>
      {rows.map((row, index) => (
        <Group key={index} align="flex-start" wrap="nowrap">
          <TextInput
            aria-label="Variable name"
            placeholder="legal_entity"
            value={row.key}
            onChange={(event) =>
              update(
                rows.map((r, i) =>
                  i === index
                    ? { ...r, key: event.currentTarget.value.toLowerCase() }
                    : r,
                ),
              )
            }
            styles={{
              input: { fontFamily: "var(--mantine-font-family-monospace)" },
            }}
            w={220}
          />
          <Textarea
            aria-label="Variable value"
            placeholder="Example Robotics LLC"
            value={row.value}
            onChange={(event) =>
              update(
                rows.map((r, i) =>
                  i === index ? { ...r, value: event.currentTarget.value } : r,
                ),
              )
            }
            autosize
            minRows={1}
            style={{ flex: 1 }}
          />
          <Button
            variant="subtle"
            color="red"
            size="compact-sm"
            mt={6}
            onClick={() => update(rows.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </Group>
      ))}
      <Group>
        <Button
          variant="light"
          size="xs"
          onClick={() => update([...rows, { key: "", value: "" }])}
        >
          Add a variable
        </Button>
      </Group>
    </Stack>
  );
}

function Form({ initial }: { initial: AdminSettings }) {
  const { refresh } = useSite();
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [values, setValues] = useState<Settings>(initial);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSaved(false);
    setValues((current) => ({ ...current, [key]: value }));
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          await api("PATCH", "/admin/settings", values);
          await refresh();
          setSaved(true);
        });
      }}
    >
      <Stack gap="lg">
        <TextInput
          label="Site name"
          description="Shown at the top of every page and on signed records."
          value={values.siteName}
          onChange={(event) => set("siteName", event.currentTarget.value)}
          required
        />
        <Stack gap="xs">
          <Select
            label="Time zone"
            description="Times are stored in UTC and shown, on screen and on signed records, in this zone. Type to search."
            data={timeZones(values.timezone)}
            value={values.timezone}
            onChange={(value) => value && set("timezone", value)}
            searchable
            allowDeselect={false}
            maw={420}
          />
          {browserZone !== values.timezone && (
            <Group gap="xs">
              <Text size="sm">Your browser is set to {browserZone}.</Text>
              <Button
                size="compact-xs"
                variant="light"
                onClick={() => set("timezone", browserZone)}
              >
                Use {browserZone}
              </Button>
            </Group>
          )}
        </Stack>

        <Stack gap="sm">
          <Title order={4}>Minors</Title>
          <Switch
            label="People under the adult age can take part"
            description="When on, new accounts are asked whether they are an adult. Leave it off if everyone here is an adult."
            checked={values.minorsEnabled}
            onChange={(event) =>
              set("minorsEnabled", event.currentTarget.checked)
            }
          />
          {values.minorsEnabled && (
            <>
              <Switch
                label="A parent or guardian signs for them"
                description="Parents get their own accounts, can add their children, and sign on their behalf. Turn this off only if minors may sign for themselves."
                checked={values.guardiansEnabled}
                onChange={(event) =>
                  set("guardiansEnabled", event.currentTarget.checked)
                }
              />
              <NumberInput
                label="Adult age"
                description="From this age, people sign for themselves."
                value={values.adultAge}
                onChange={(value) =>
                  typeof value === "number" && set("adultAge", value)
                }
                min={13}
                max={25}
                allowDecimal={false}
                maw={260}
              />
            </>
          )}
        </Stack>

        <VariablesEditor
          variables={values.variables}
          onChange={(variables) => set("variables", variables)}
        />

        <Stack gap="sm">
          <Title order={4}>Sign-in and site address</Title>
          <NumberInput
            label="Days before someone has to sign in again"
            value={values.sessionDays}
            onChange={(value) =>
              typeof value === "number" && set("sessionDays", value)
            }
            min={1}
            max={365}
            allowDecimal={false}
            maw={260}
          />
          <Stack gap={2}>
            <Text size="sm" fw={500}>
              Site address
            </Text>
            <Text>{initial.origin}</Text>
            <Text size="xs" c="dimmed">
              {initial.originFromEnvironment
                ? "Set by whoever runs the server, with PUBLIC_BASE_URL."
                : "Recorded when the first administrator registered. Whoever runs the server can state it explicitly with PUBLIC_BASE_URL."}{" "}
              Passkeys are tied to its hostname, so it is not changed here.
            </Text>
          </Stack>
        </Stack>

        <Problem message={action.error} />
        <Group>
          <Button type="submit" loading={action.busy}>
            Save settings
          </Button>
          {saved && <Text c="green">Saved.</Text>}
        </Group>
      </Stack>
    </form>
  );
}

export function SettingsPage() {
  const { refresh } = useSite();
  const settings = useLoad<AdminSettings>("/admin/settings");
  return (
    <Stack gap="lg">
      <Title order={2}>Settings</Title>
      <Loaded data={settings.data} error={settings.error}>
        {(data) => (
          // Remounted when the stored settings change underneath it, as they
          // do when a configuration file is applied.
          <Form key={JSON.stringify(data)} initial={data} />
        )}
      </Loaded>
      <ConfigFile
        onApplied={async () => {
          await Promise.all([settings.reload(), refresh()]);
        }}
      />
    </Stack>
  );
}
