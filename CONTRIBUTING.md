# Contributing to Deploy King

Thank you for helping. A few things to know first.

## Licence and the CLA

Deploy King is licensed under [FSL-1.1-ALv2](LICENSE). Before we can merge your first pull request, please sign the [Contributor License Agreement](legal/CLA.md): add the sentence from its "How to sign" section as a comment on your pull request. You keep the copyright in your work. The CLA lets the project keep its licensing options.

If your employer has rights in your work, make sure they allow the contribution (see section 3 of the CLA).

## Before you open a pull request

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Set up the project as described in the [README](README.md). Run the local checks in [`tests/local`](tests/local/README.md).
3. Keep pull requests focused: one change, with tests where they make sense.
4. Run the type checks (`pnpm typecheck`) and make sure the checks you touched pass.
5. Never commit secrets, `.env` files or real customer data.

## Security problems

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Conduct

Be respectful and constructive. Harassment or abuse in issues, pull requests or discussions leads to removal from the project.
