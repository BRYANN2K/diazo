import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { envHeaderNames, resolvedHeaders } from './anthropicHeaders.ts'

/* the header names that carry a credential to Anthropic; an env line under
   any spelling of one is covered by the null and the restated key below */
const AUTH_HEADER_NAMES = new Set(['authorization', 'x-api-key'])

/**
 * An Anthropic client on a person's own connected key: the turns and catalog
 * calls their account pays for. None of the server's credentials may ride
 * along:
 *
 *  - a null `authToken` keeps ANTHROPIC_AUTH_TOKEN from being sent beside the
 *    key;
 *  - the SDK folds ANTHROPIC_CUSTOM_HEADERS into every client's headers after
 *    its own auth headers, so an Authorization or X-Api-Key line there would
 *    quietly bill their calls to the server. Each env spelling of either
 *    name is nulled, Authorization is nulled and the person's key restated —
 *    under every spelling each name enters the merge with, or a second env
 *    spelling of it would be read last and win.
 */
export function personAnthropicClient(
  apiKey: string,
  options: Omit<ClientOptions, 'apiKey' | 'authToken' | 'defaultHeaders'> = {},
): Anthropic {
  return new Anthropic({
    apiKey,
    authToken: null,
    ...options,
    defaultHeaders: resolvedHeaders(
      envHeaderNames()
        .filter((name) => AUTH_HEADER_NAMES.has(name.toLowerCase()))
        .map((name): [string, string | null] => [name, null]),
      [
        ['Authorization', null],
        ['X-Api-Key', apiKey],
      ],
    ),
  })
}
