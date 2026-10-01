import {
  Alert,
  Button,
  Group,
  NativeSelect,
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

function Form({ initial }: { initial: Settings }) {
  const { refresh } = useSite();
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSaved(false);
    setValues((current) => ({ ...current, [key]: value }));
  };
  const originChanged = values.origin !== initial.origin;

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
        <TextInput
          label="Time zone"
          description="An IANA zone name such as America/Los_Angeles. Times are stored in UTC and shown in this zone."
          value={values.timezone}
          onChange={(event) => set("timezone", event.currentTarget.value)}
          required
        />

        <Stack gap="sm">
          <Title order={4}>Parents and guardians</Title>
          <Switch
            label="People under age need a parent or guardian to sign"
            description="When on, new accounts are asked whether they are an adult, and parents can add children and sign for them."
            checked={values.guardiansEnabled}
            onChange={(event) =>
              set("guardiansEnabled", event.currentTarget.checked)
            }
          />
          <NumberInput
            label="Age at which someone signs for themself"
            value={values.adultAge}
            onChange={(value) =>
              typeof value === "number" && set("adultAge", value)
            }
            min={13}
            max={25}
            allowDecimal={false}
            maw={260}
          />
        </Stack>

        <Stack gap="sm">
          <Title order={4}>Sign-in and network</Title>
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
          <NativeSelect
            label="Where the visitor's network address comes from"
            description="It is printed on signed records. Behind a reverse proxy, choose the header that proxy sets; a header your proxy does not overwrite can be forged by a visitor."
            data={[
              {
                value: "",
                label:
                  "The connection itself (no reverse proxy, or Cloudflare Workers)",
              },
              { value: "x-forwarded-for", label: "X-Forwarded-For header" },
              { value: "x-real-ip", label: "X-Real-IP header" },
              { value: "cf-connecting-ip", label: "CF-Connecting-IP header" },
            ]}
            value={values.clientIpHeader ?? ""}
            onChange={(event) =>
              set(
                "clientIpHeader",
                (event.currentTarget.value ||
                  null) as Settings["clientIpHeader"],
              )
            }
          />
          <TextInput
            label="Site address"
            description="The address people type to get here. Passkeys are tied to its hostname."
            value={values.origin ?? ""}
            onChange={(event) => set("origin", event.currentTarget.value)}
            required
          />
          {originChanged && (
            <Alert
              color="red"
              title="Changing the site address can lock everyone out"
            >
              Requests are only accepted from this address, and if the hostname
              changes every existing passkey stops working, including yours. If
              you get it wrong, fix it from the server with{" "}
              <code>clearance config set origin</code>.
            </Alert>
          )}
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
  const settings = useLoad<Settings>("/admin/settings");
  return (
    <Stack gap="lg">
      <Title order={2}>Settings</Title>
      <Loaded data={settings.data} error={settings.error}>
        {(data) => <Form initial={data} />}
      </Loaded>
    </Stack>
  );
}
