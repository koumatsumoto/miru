# MIRU native smoke · 日本語

**Bold**, _italic_, ~~struck~~ and `read-only code` remain text. Source should retain this whole file.

- [x] Static task state
- [ ] Real Windows GUI acceptance remains pending

| View       | Expected                       |
| ---------- | ------------------------------ |
| Files      | Local text and native Markdown |
| Repository | Bounded read-only comparison   |

## Flowchart

```mermaid
flowchart LR
    A[開始] --> B{確認}
    B -->|はい| C[完了]
    B -->|いいえ| A
```

## Sequence

```mermaid
sequenceDiagram
    participant U as User
    participant M as MIRU
    U->>M: Open file
    M-->>U: Read only
```

## Expected source fallback

```mermaid
pie
    "Unsupported in this milestone" : 100
```

## Inactive content

[This is text, not an active link](https://example.invalid/miru-smoke)

![This is alt text, not a downloaded image](https://example.invalid/miru-smoke.png)

<strong>HTML stays literal text, not active UI.</strong>
