import {
  Alert,
  Badge,
  Button,
  Center,
  CopyButton,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { QRCodeSVG } from "qrcode.react";
import { type ReactNode, useState } from "react";
import { type ClearanceStatus, messageOf } from "../api.ts";

export function Loading() {
  return (
    <Center py="xl">
      <Loader />
    </Center>
  );
}

export function Problem({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert color="red" title="That did not work">
      {message}
    </Alert>
  );
}

/** Shows loading, then an error, then the content once `data` has arrived. */
export function Loaded<T>({
  data,
  error,
  children,
}: {
  data: T | null;
  error: string | null;
  children(data: T): ReactNode;
}) {
  if (error) return <Problem message={error} />;
  if (data === null) return <Loading />;
  return <>{children(data)}</>;
}

/** Runs an action, tracking whether it is in flight and what went wrong. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

const WHO = {
  self: "the person",
  guardian: "a parent or guardian",
  minor: "the student",
} as const;

/** One line saying where a clearance stands and, if stuck, on whom. */
export function describeStatus(status: ClearanceStatus): {
  color: string;
  label: string;
  detail: string | null;
} {
  const waiting = status.waitingOn.map((who) => WHO[who]).join(" and ");
  switch (status.state) {
    case "active":
      return { color: "green", label: "Current", detail: null };
    case "pending":
      return {
        color: "yellow",
        label: "Partly signed",
        detail: `Waiting on ${waiting}.`,
      };
    case "expired":
      return {
        color: "orange",
        label: "Expired",
        detail: `Needs signing again by ${waiting}.`,
      };
    case "stale":
      return {
        color: "orange",
        label: "Needs signing again",
        detail: status.reason,
      };
    default:
      return status.required
        ? {
            color: "red",
            label: "Not signed",
            detail: `Needs ${waiting} to sign.`,
          }
        : { color: "gray", label: "Not signed", detail: "Optional." };
  }
}

export function StatusBadge({ status }: { status: ClearanceStatus }) {
  const { color, label } = describeStatus(status);
  return (
    <Badge color={color} variant="light">
      {label}
    </Badge>
  );
}

export function linkFor(token: string): string {
  return `${window.location.origin}/join/${token}`;
}

/** A link to hand to someone: copyable, and scannable from another screen. */
export function ShareLink({
  token,
  note,
}: {
  token: string;
  note?: ReactNode;
}) {
  const url = linkFor(token);
  const [showCode, setShowCode] = useState(false);
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        {note && <Text size="sm">{note}</Text>}
        <TextInput
          readOnly
          value={url}
          aria-label="Link"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Group gap="xs">
          <CopyButton value={url}>
            {({ copied, copy }) => (
              <Button size="xs" variant="light" onClick={copy}>
                {copied ? "Copied" : "Copy link"}
              </Button>
            )}
          </CopyButton>
          <Button
            size="xs"
            variant="subtle"
            onClick={() => setShowCode((shown) => !shown)}
          >
            {showCode ? "Hide QR code" : "Show QR code"}
          </Button>
        </Group>
        {showCode && (
          <Center bg="white" p="md">
            <QRCodeSVG value={url} size={220} />
          </Center>
        )}
      </Stack>
    </Paper>
  );
}
