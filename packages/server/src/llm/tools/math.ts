/**
 * Evaluates a basic arithmetic expression.
 *
 * The model may write expressions that mix `+`, `-`, `*`, `/`, and
 * parentheses; the input is parsed with a small recursive-descent grammar
 * instead of `eval`, so arbitrary code never runs. Errors are returned as
 * strings so the model can correct itself.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const TOKEN_RE = /^\s*(\d+(?:\.\d+)?|[+\-*/()]|.)/;

/**
 * Tokenizes and evaluates `expression` with standard precedence:
 * parentheses > unary `+`/`-` > `*`/`/` > `+`/`-`.
 */
export function calculateResult(expression: string): number {
    const tokens: string[] = [];
    let rest = expression;
    while (rest.trim() !== "") {
        const match = TOKEN_RE.exec(rest);
        if (!match) {
            throw new Error(`cannot parse near ${JSON.stringify(rest.trim())}`);
        }
        tokens.push(match[1]);
        rest = rest.slice(match[0].length);
    }
    if (tokens.length === 0) {
        throw new Error("empty expression");
    }

    let pos = 0;

    function peek(): string | null {
        return pos < tokens.length ? tokens[pos] : null;
    }

    function take(): string {
        const t = peek();
        if (t === null) {
            throw new Error("unexpected end of expression");
        }
        pos += 1;
        return t;
    }

    function atom(): number {
        const t = take();
        if (t === "(") {
            const value = addSub();
            if (take() !== ")") {
                throw new Error("expected ')'");
            }
            return value;
        }
        if (/^\d/.test(t)) {
            return Number(t);
        }
        throw new Error(`unexpected token '${t}'`);
    }

    function unary(): number {
        const t = peek();
        if (t === "+" || t === "-") {
            take();
            const value = unary();
            return t === "-" ? -value : value;
        }
        return atom();
    }

    function mulDiv(): number {
        let value = unary();
        for (let t = peek(); t === "*" || t === "/"; t = peek()) {
            take();
            const rhs = unary();
            if (t === "/" && rhs === 0) {
                throw new Error("division by zero");
            }
            value = t === "*" ? value * rhs : value / rhs;
        }
        return value;
    }

    function addSub(): number {
        let value = mulDiv();
        for (let t = peek(); t === "+" || t === "-"; t = peek()) {
            take();
            const rhs = mulDiv();
            value = t === "+" ? value + rhs : value - rhs;
        }
        return value;
    }

    const result = addSub();
    const leftover = peek();
    if (leftover !== null) {
        throw new Error(`unexpected trailing token '${leftover}'`);
    }
    return result;
}

export const calculate = tool(
    async ({ expression }: { expression: string }): Promise<string> => {
        try {
            return String(calculateResult(expression));
        } catch (err) {
            return `error: ${err instanceof Error ? err.message : String(err)}`;
        }
    },
    {
        name: "calculate",
        description:
            "Evaluates a basic arithmetic expression (+, -, *, /, parentheses) " +
            "and returns the numeric result.",
        schema: z.object({
            expression: z
                .string()
                .describe("Arithmetic expression, e.g. '(3 + 4) * 2'"),
        }),
    },
);
