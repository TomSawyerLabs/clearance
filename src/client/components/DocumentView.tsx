import {
  Anchor,
  Blockquote,
  Code,
  Divider,
  List,
  Text,
  Title,
} from "@mantine/core";
import { Fragment, useMemo } from "react";
import {
  type Block,
  type Inline,
  parseDocument,
} from "../../shared/document.ts";

// Renders the same block model the server lays out as a PDF, so what is read
// on screen is what ends up in the signed record.

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

function Blocks({ blocks }: { blocks: Block[] }) {
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
                    <Blocks blocks={item} />
                  </List.Item>
                ))}
              </List>
            );
          case "quote":
            return (
              <Blockquote key={index} my="sm" p="sm">
                <Blocks blocks={block.blocks} />
              </Blockquote>
            );
          case "rule":
            return <Divider key={index} my="md" />;
        }
      })}
    </>
  );
}

export function DocumentView({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseDocument(markdown), [markdown]);
  return <Blocks blocks={blocks} />;
}
