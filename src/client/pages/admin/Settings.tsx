import {
  Button,
  Group,
  Select,
  NumberInput,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { api, type Settings } from "../../api.ts";
import { Loaded, Problem, useAction } from "../../components/common.tsx";
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
  const settings = useLoad<AdminSettings>("/admin/settings");
  return (
    <Stack gap="lg">
      <Title order={2}>Settings</Title>
      <Loaded data={settings.data} error={settings.error}>
        {(data) => <Form initial={data} />}
      </Loaded>
    </Stack>
  );
}
