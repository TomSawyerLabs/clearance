import {
  Anchor,
  Blockquote,
  Code,
  Divider,
  List,
  Text,
  Title,
} from "@mantine/core";
import { Fragment, type ReactNode, useMemo } from "react";
import {
  type Block,
  type Field,
  type Inline,
  parseDocument,
} from "../../shared/document.ts";

// Renders the same block model the server lays out as a PDF, so what is read
// on screen is what ends up in the signed record. A question placed in the
// text is rendered by whoever shows the document: an input on the signing
// page, the answer on a record, a placeholder in the editor's preview.

function Inlines({ inlines }: { inlines: Inline[] }) {
  return (
    <>
      {inlines.map((inline, index) => {
        if (inline.text === "\n") return <br key={index} />;
        let node: React.ReactNode = inline.text;
        if (inline.code) node = <Code>{node}</Code>;
        if (inline.italic) node = <em>{node}</em>;
        if (inline.bold) node = <strong>{node}</strong>;
        if (inline.href) {
          node = (
            <Anchor href={inline.href} target="_blank" rel="noreferrer">
              {node}
            </Anchor>
          );
        }
        return <Fragment key={index}>{node}</Fragment>;
      })}
    </>
  );
}

type QuestionRenderer = (key: string) => ReactNode;

function Blocks({
  blocks,
  question,
}: {
  blocks: Block[];
  question: QuestionRenderer;
}) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading":
            return (
              <Title
                key={index}
                order={Math.min(block.level + 1, 6) as 2 | 3 | 4 | 5 | 6}
                mt="md"
                mb="xs"
              >
                <Inlines inlines={block.inlines} />
              </Title>
            );
          case "paragraph":
            return (
              <Text key={index} mb="sm">
                <Inlines inlines={block.inlines} />
              </Text>
            );
          case "list":
            return (
              <List
                key={index}
                type={block.ordered ? "ordered" : "unordered"}
                start={block.ordered ? block.start : undefined}
                mb="sm"
                spacing="xs"
                withPadding
              >
                {block.items.map((item, itemIndex) => (
                  <List.Item key={itemIndex}>
                    <Blocks blocks={item} question={question} />
                  </List.Item>
                ))}
              </List>
            );
          case "quote":
            return (
              <Blockquote key={index} my="sm" p="sm">
                <Blocks blocks={block.blocks} question={question} />
              </Blockquote>
            );
          case "rule":
            return <Divider key={index} my="md" />;
          case "question":
            return (
              <div key={index} className="placed-question">
                {question(block.key)}
              </div>
            );
        }
      })}
    </>
  );
}

/** What a placed question looks like when nobody is answering it: its wording, marked. */
export function QuestionPlaceholder({
  field,
  fieldKey,
}: {
  field: Field | undefined;
  fieldKey: string;
}) {
  return (
    <Text mb="sm" c={field ? "blue" : "red"} fs="italic">
      {field
        ? `[${field.label}]`
        : `[There is no question with key "${fieldKey}"]`}
    </Text>
  );
}

export function DocumentView({
  markdown,
  fields = [],
  question,
}: {
  markdown: string;
  /** The document's questions, for showing a placed one by its wording. */
  fields?: Field[];
  /** How to render a question placed in the text. Default: its wording. */
  question?: QuestionRenderer;
}) {
  const blocks = useMemo(() => parseDocument(markdown), [markdown]);
  const render: QuestionRenderer =
    question ??
    ((key) => (
      <QuestionPlaceholder
        field={fields.find((field) => field.key === key)}
        fieldKey={key}
      />
    ));
  return <Blocks blocks={blocks} question={render} />;
}
