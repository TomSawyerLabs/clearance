import {
  Alert,
  Button,
  Divider,
  Radio,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { type InviteInfo, post, registerPasskey, signIn } from "../api.ts";
import { Loaded, Problem, useAction } from "../components/common.tsx";
import { useLoad, useSite } from "../site.tsx";

// Where every invitation link lands. What it offers depends on the kind of
// link and on whether the visitor already has an account.

type Who = "adult" | "minor" | "guardian";

function groupName(invite: InviteInfo): string {
  if (!invite.group) return "the group";
  return invite.group.code
    ? `${invite.group.name} (${invite.group.code})`
    : invite.group.name;
}

/** A parent adds a child, who joins the group the link is for. */
function EnrolChild({ token, invite }: { token: string; invite: InviteInfo }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [birthdate, setBirthdate] = useState("");
  const action = useAction();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          await post("/family/wards", { name, birthdate, invite: token });
          navigate("/");
        });
      }}
    >
      <Stack>
        <Text>
          Enter your child's details. They will be added to {groupName(invite)},
          and you will be able to sign for them.
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
        <Button
          type="submit"
          loading={action.busy}
          disabled={!name.trim() || !birthdate}
        >
          Add my child
        </Button>
      </Stack>
    </form>
  );
}

interface Props {
  token: string;
  invite: InviteInfo;
  /** A parent who came to enrol a child, not to join. Survives their sign-up. */
  enrolling: boolean;
  setEnrolling(enrolling: boolean): void;
}

function SignedIn({ token, invite, enrolling, setEnrolling }: Props) {
  const { state, refresh } = useSite();
  const navigate = useNavigate();
  const action = useAction();
  const me = state.me!;

  const accept = () =>
    action.run(async () => {
      const result = await post<{ groupId: string | null }>(
        `/invites/${token}/accept`,
      );
      await refresh();
      navigate(
        invite.kind === "group_manager" && result.groupId
          ? `/groups/${result.groupId}`
          : "/",
      );
    });

  if (invite.kind === "claim" || invite.kind === "passkey") {
    return (
      <Alert color="yellow" title={`You are signed in as ${me.name}`}>
        This link sets up a passkey for {invite.targetName}. Sign out from the
        Account page first, then open the link again.
      </Alert>
    );
  }
  if (invite.kind === "guardian") {
    return (
      <Stack>
        <Text>
          {invite.targetName} has asked you to be their parent or guardian here.
          Accepting lets you sign documents on their behalf.
        </Text>
        <Problem message={action.error} />
        <Button loading={action.busy} onClick={accept}>
          I am {invite.targetName}'s parent or guardian
        </Button>
      </Stack>
    );
  }
  if (enrolling) return <EnrolChild token={token} invite={invite} />;
  return (
    <Stack>
      <Text>
        {invite.inviterName} has invited you to {groupName(invite)}
        {invite.kind === "group_manager" ? " as a manager" : ""}. You are signed
        in as {me.name}.
      </Text>
      <Problem message={action.error} />
      <Button loading={action.busy} onClick={accept}>
        Join {groupName(invite)}
      </Button>
      {invite.kind === "group_member" &&
        state.site.guardiansEnabled &&
        !me.minor && (
          <Button variant="light" onClick={() => setEnrolling(true)}>
            Enrol my child instead
          </Button>
        )}
    </Stack>
  );
}

function SignedOut({ token, invite, setEnrolling }: Props) {
  const { state, refresh } = useSite();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [who, setWho] = useState<Who>("adult");
  const [birthdate, setBirthdate] = useState("");
  const create = useAction();
  const login = useAction();
  const guardians = state.site.guardiansEnabled;
  const age = state.site.adultAge;

  if (invite.kind === "claim" || invite.kind === "passkey") {
    return (
      <Stack>
        <Text>
          This link sets up a passkey for <strong>{invite.targetName}</strong>{" "}
          on this device. A passkey is your device's fingerprint, face or PIN;
          there is no password.
        </Text>
        <Problem message={create.error} />
        <Button
          loading={create.busy}
          onClick={() =>
            create.run(async () => {
              await registerPasskey({ invite: token });
              await refresh();
              navigate("/");
            })
          }
        >
          Set up my passkey
        </Button>
      </Stack>
    );
  }

  // Only a group member link can be used by a minor or to enrol a child.
  const choice = invite.kind === "group_member" && guardians;
  const intro =
    invite.kind === "guardian"
      ? `${invite.targetName} has asked you to be their parent or guardian here, so that you can sign documents on their behalf.`
      : `${invite.inviterName} has invited you to ${groupName(invite)}${invite.kind === "group_manager" ? " as a manager" : ""}.`;

  return (
    <Stack>
      <Text>{intro}</Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create.run(async () => {
            await registerPasskey({
              invite: token,
              name,
              ...(guardians && { adult: !choice || who !== "minor" }),
              ...(choice && who === "minor" && { birthdate }),
              ...(choice && who === "guardian" && { as: "guardian" as const }),
            });
            // A parent stays here to add their child; everyone else is done.
            const parent = choice && who === "guardian";
            setEnrolling(parent);
            await refresh();
            if (!parent) navigate("/");
          });
        }}
      >
        <Stack>
          {choice && (
            <Radio.Group
              label="Who are you?"
              value={who}
              onChange={(value) => setWho(value as Who)}
            >
              <Stack gap="xs" mt="xs">
                <Radio
                  value="adult"
                  label={`I am joining, and I am ${age} or older`}
                />
                <Radio
                  value="minor"
                  label={`I am joining, and I am under ${age}`}
                />
                <Radio
                  value="guardian"
                  label="I am a parent or guardian enrolling my child"
                />
              </Stack>
            </Radio.Group>
          )}
          <TextInput
            label="Your full name"
            description={
              choice && who === "guardian"
                ? "Yours, not your child's."
                : undefined
            }
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
          />
          {choice && who === "minor" && (
            <TextInput
              label="Your date of birth"
              description="A parent or guardian will need to sign for you. You can send them a link after this."
              type="date"
              value={birthdate}
              onChange={(event) => setBirthdate(event.currentTarget.value)}
              required
            />
          )}
          <Text size="sm" c="dimmed">
            You will sign in with a passkey: this device's fingerprint, face or
            PIN. There is no password to remember.
          </Text>
          <Problem message={create.error} />
          <Button
            type="submit"
            loading={create.busy}
            disabled={!name.trim() || (choice && who === "minor" && !birthdate)}
          >
            Create my account
          </Button>
        </Stack>
      </form>
      <Divider label="Already have an account here?" />
      <Problem message={login.error} />
      <Button
        variant="light"
        loading={login.busy}
        onClick={() =>
          login.run(async () => {
            await signIn();
            await refresh();
          })
        }
      >
        Sign in with a passkey
      </Button>
    </Stack>
  );
}

export function JoinPage() {
  const { token = "" } = useParams();
  const { state } = useSite();
  const invite = useLoad<InviteInfo>(`/invites/${token}`);
  const [enrolling, setEnrolling] = useState(false);

  return (
    <Stack maw={520} mx="auto" mt="lg">
      <Title order={2}>{state.site.name}</Title>
      {invite.error ? (
        <Stack>
          <Alert color="red" title="This link cannot be used">
            {invite.error} Ask whoever sent it for a new one.
          </Alert>
          <Button component={Link} to="/" variant="light">
            Go to the home page
          </Button>
        </Stack>
      ) : (
        <Loaded data={invite.data} error={null}>
          {(info) => {
            const props = { token, invite: info, enrolling, setEnrolling };
            return state.me ? (
              <SignedIn {...props} />
            ) : (
              <SignedOut {...props} />
            );
          }}
        </Loaded>
      )}
    </Stack>
  );
}
