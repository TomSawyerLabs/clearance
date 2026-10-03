import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, messageOf, signDocument, type SigningPage } from "../api.ts";
import { Loaded, Problem } from "../components/common.tsx";
import { DocumentView } from "../components/DocumentView.tsx";
import { FieldInput } from "../components/FieldInput.tsx";
import {
  type Answers,
  fieldsFor,
  parseDocument,
  placedQuestions,
} from "../../shared/document.ts";
import { useLoad } from "../site.tsx";

function SignForm({ page }: { page: SigningPage }) {
  const navigate = useNavigate();
  const capacity = page.capacity!;
  const fields = fieldsFor(page.version.fields, capacity);
  // Questions placed in the text are asked there; the rest follow it.
  const placed = useMemo(
    () => new Set(placedQuestions(parseDocument(page.version.body))),
    [page.version.body],
  );
  const trailing = fields.filter((field) => !placed.has(field.key));
  const [answers, setAnswers] = useState<Answers>({});
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});

  const role =
    capacity === "attester"
      ? `You are certifying ${page.subject.name}, as ${page.signer.name}, their mentor.`
      : capacity === "guardian"
        ? `You are signing as ${page.signer.name}, parent or legal guardian of ${page.subject.name}.`
        : capacity === "minor"
          ? `You are signing as ${page.signer.name}. A parent or guardian signs this as well.`
          : `You are signing as ${page.signer.name}.`;

  async function submit() {
    setBusy(true);
    setError(null);
    setProblems({});
    try {
      const result = await signDocument(
        page.clearance.id,
        page.subject.id,
        answers,
      );
      navigate(`/records/${result.signatureId}`, {
        state: { justSigned: true, granted: result.granted },
      });
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.details &&
        typeof cause.details === "object" &&
        !Array.isArray(cause.details)
      ) {
        setProblems(cause.details as Record<string, string>);
      }
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const input = (key: string) => {
    const field = fields.find((candidate) => candidate.key === key);
    // Placed, but not for this signer (another audience): nothing to show.
    if (!field) return null;
    return (
      <FieldInput
        field={field}
        value={answers[field.key]}
        problem={problems[field.key]}
        onChange={(value) =>
          setAnswers((current) => ({ ...current, [field.key]: value }))
        }
      />
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <Paper withBorder p="md">
          <DocumentView markdown={page.version.body} question={input} />
        </Paper>
        {trailing.length > 0 && (
          <>
            <Divider label="Your answers" />
            {trailing.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={answers[field.key]}
                problem={problems[field.key]}
                onChange={(value) =>
                  setAnswers((current) => ({ ...current, [field.key]: value }))
                }
              />
            ))}
          </>
        )}
        <Divider label="Signature" />
        <Text fw={600}>{role}</Text>
        <Checkbox
          label={page.statement}
          checked={agreed}
          onChange={(event) => setAgreed(event.currentTarget.checked)}
        />
        <Problem message={error} />
        <Button type="submit" size="md" loading={busy} disabled={!agreed}>
          {capacity === "attester"
            ? "Certify with my passkey"
            : "Sign with my passkey"}
        </Button>
        <Text size="sm" c="dimmed">
          Your device will ask for your fingerprint, face or PIN. That approval
          is your signature.
        </Text>
      </Stack>
    </form>
  );
}

export function SignPage() {
  const { clearanceId, subjectId } = useParams();
  const page = useLoad<SigningPage>(`/sign/${clearanceId}/${subjectId}`);

  return (
    <Loaded data={page.data} error={page.error}>
      {(data) => (
        <Stack>
          <Stack gap={2}>
            <Title order={2}>{data.version.title}</Title>
            <Text c="dimmed" size="sm">
              {data.clearance.name}, version {data.version.version}
              {data.subject.id !== data.signer.id
                ? `, for ${data.subject.name}`
                : ""}
            </Text>
          </Stack>
          {data.capacity ? (
            <SignForm page={data} />
          ) : (
            <Stack>
              <Paper withBorder p="md">
                <DocumentView
                  markdown={data.version.body}
                  fields={data.version.fields}
                />
              </Paper>
              <Alert color="yellow" title="You cannot sign this right now">
                {data.blocked}
              </Alert>
              <Button component={Link} to="/" variant="light">
                Back to my clearances
              </Button>
            </Stack>
          )}
        </Stack>
      )}
    </Loaded>
  );
}
