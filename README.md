# llm-wiki-cloudflare-codemode

An agentic riff of Karpathy's [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) on Cloudflare's developer platform stack, including Codemode and dynamic Workers.

## What is llm-wiki?

Andrej Karpathy's **llm-wiki** is an LLM-driven approach to building a persistent, evolving Markdown wiki as a personal knowledge base. Instead of stateless Retrieval-Augmented Generation (RAG), an LLM agent iteratively reads, writes, cross-links, and curates structured Markdown documents — creating a dynamic, auditable "second brain" that grows and compounds knowledge over time.

> **Original gist:** [https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## This Project

This project extends that idea onto the **Cloudflare developer platform**, leveraging:

- **Cloudflare Workers** — serverless compute at the edge
- **Codemode** — AI-native code generation and execution
- **Dynamic Workers** — runtime-generated Worker scripts for agentic tasks

## Resources

For blog posts, videos, and industry reactions to the llm-wiki idea, see [llm-wiki-resources.md](./llm-wiki-resources.md).
