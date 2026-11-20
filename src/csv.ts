export function parseCsv(input: string): string[][] {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: "unquoted" | "quoted" | "closed" = "unquoted";

  function endField(): void {
    row.push(field);
    field = "";
    state = "unquoted";
  }

  function endRow(): void {
    endField();
    rows.push(row);
    row = [];
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state === "quoted") {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        state = "closed";
      }
      continue;
    }

    if (character === ",") {
      endField();
    } else if (character === "\r" || character === "\n") {
      endRow();
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
    } else if (state === "closed") {
      throw new Error(`Unexpected character after quoted CSV field at offset ${index}`);
    } else if (character === '"') {
      if (field.length !== 0) {
        throw new Error(`Unexpected quote in CSV field at offset ${index}`);
      }
      state = "quoted";
    } else {
      field += character;
    }
  }

  if (state === "quoted") {
    throw new Error("Unterminated quoted CSV field");
  }
  if (row.length > 0 || field.length > 0 || state === "closed") {
    endRow();
  }
  return rows;
}

export function formatCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => `${row.map(escapeField).join(",")}\n`).join("");
}

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
