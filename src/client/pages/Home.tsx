import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { type Family, post } from "../api.ts";
import { ClearanceList } from "../components/ClearanceList.tsx";
import {
  Loaded,
  Problem,
  ShareLink,
  useAction,
} from "../components/common.tsx";
import { useLoad, useSite } from "../site.tsx";

type Ward = Family["wards"][number];

function WardCard({ ward }: { ward: Ward }) {
  const [claim, setClaim] = useState<string | null>(null);
  const action = useAction();
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group gap="xs">
          <Title order={4}>{ward.name}</Title>
          {!ward.minor && <Badge color="gray">Now an adult</Badge>}
        </Group>
        {!ward.minor && (
          <Text size="sm">
            {ward.name} is old enough to sign personally, so you can no longer
            sign for them.
            {ward.managed ? " Give them their own sign-in below." : ""}
          </Text>
        )}
        <ClearanceList
          subjectId={ward.id}
          clearances={ward.clearances}
          signAs={ward.minor ? "guardian" : null}
        />
        {ward.managed && (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              {ward.name} has no sign-in of their own; you run this account for
              them.
            </Text>
            <Problem message={action.error} />
            {claim ? (
              <ShareLink
                token={claim}
                note={`Open this on ${ward.name}'s own device to give them a passkey. It works once, for 7 days.`}
              />
            ) : (
              <Group>
                <Button
                  size="xs"
                  variant="light"
                  loading={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      const result = await post<{ token: string }>(
                        `/family/wards/${ward.id}/claim-invite`,
                      );
                      setClaim(result.token);
                    })
                  }
                >
                  Give {ward.name} their own sign-in
                </Button>
              </Group>
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

function AddChild({ onAdded }: { onAdded(): void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [birthdate, setBirthdate] = useState("");
  const action = useAction();
  if (!open) {
    return (
      <Group>
        <Button variant="light" onClick={() => setOpen(true)}>
          Add a child
        </Button>
      </Group>
    );
  }
  return (
    <Paper withBorder p="md">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await post("/family/wards", { name, birthdate });
            setName("");
            setBirthdate("");
            setOpen(false);
            onAdded();
          });
        }}
      >
        <Stack>
          <Text size="sm">
            To put your child in a team, use the team's link instead: it adds
            them to the team at the same time.
          </Text>
          <TextInput
            label="Child's full name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
          />
          <TextInput
            label="Child's date of birth"
            type="date"
            value={birthdate}
            onChange={(event) => setBirthdate(event.currentTarget.value)}
            required
          />
          <Problem message={action.error} />
          <Group>
            <Button
              type="submit"
              loading={action.busy}
              disabled={!name.trim() || !birthdate}
            >
              Add
            </Button>
            <Button variant="subtle" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}

/** A minor's view of who can sign for them, and the link to bring a parent in. */
function MyGuardians({ family }: { family: Family }) {
  const [link, setLink] = useState<string | null>(null);
  const action = useAction();
  return (
    <Stack gap="sm">
      <Title order={3}>Your parent or guardian</Title>
      {family.guardians.length === 0 ? (
        <Alert color="yellow" title="A parent or guardian has to sign for you">
          Send them the link below. They open it, make their own account, and
          can then sign.
        </Alert>
      ) : (
        <Text>
          {family.guardians.map((guardian) => guardian.name).join(", ")}
        </Text>
      )}
      <Problem message={action.error} />
      {link ? (
        <ShareLink
          token={link}
          note="Send this to your parent or guardian. It works for 30 days."
        />
      ) : (
        <Group>
          <Button
            variant={family.guardians.length ? "light" : "filled"}
            loading={action.busy}
            onClick={() =>
              action.run(async () => {
                const result = await post<{ token: string }>(
                  "/family/guardian-invite",
                );
                setLink(result.token);
              })
            }
          >
            {family.guardians.length
              ? "Add another parent or guardian"
              : "Get a link for my parent or guardian"}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

export function HomePage() {
  const { state } = useSite();
  const family = useLoad<Family>("/family");

  return (
    <Loaded data={family.data} error={family.error}>
      {(data) => (
        <Stack gap="xl">
          <Stack gap="sm">
            <Title order={2}>My clearances</Title>
            <ClearanceList
              subjectId={data.me.id}
              clearances={data.me.clearances}
              signAs={data.me.minor ? "minor" : "self"}
            />
          </Stack>

          {data.me.minor && <MyGuardians family={data} />}

          {state.site.guardiansEnabled && !data.me.minor && (
            <Stack gap="sm">
              <Title order={3}>My children</Title>
              {data.wards.length === 0 && (
                <Text c="dimmed" size="sm">
                  If you are a parent or guardian, add your child here to sign
                  for them.
                </Text>
              )}
              {data.wards.map((ward) => (
                <WardCard key={ward.id} ward={ward} />
              ))}
              <AddChild onAdded={family.reload} />
            </Stack>
          )}
        </Stack>
      )}
    </Loaded>
  );
}
