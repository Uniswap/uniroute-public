# UniRoute

UniRoute is Uniswap's off-chain routing engine for generating optimized swap quotes across Uniswap V2, V3, and V4 protocols + hooks.

## Overview

This is the **open source version** of UniRoute, containing the core routing algorithm logic. It demonstrates how Uniswap discovers pools, finds optimal routes, and generates quotes across all supported blockchains.

## What's Included

- **`src/core/`** - The heart of the routing algorithm, including:
  - Pool discovery strategies
  - Route finding and optimization
  - Quote generation and selection
  - Gas estimation
  - Swap simulation

- **`src/lib/config.ts`** - Configuration structure (with placeholder values)

- **`src/stores/route/uniroutes/UniRoutesRepository.ts`** - Protocol definitions describing which Uniswap versions are considered and when

## License

MIT License.
