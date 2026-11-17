import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'

/**
 * An Anthropic client on a person's own connected key: the turns and catalog
 * calls their account pays for. None of the server's credentials may ride
 * along:
 *
 *  - a null `authToken` keeps ANTHROPIC_AUTH_TOKEN from being sent beside the
 *    key;
 *  - the SDK folds ANTHROPIC_CUSTOM_HEADERS into every client's headers after
 *    its own auth headers, so an Authorization or X-Api-Key line there would
 *    quietly bill their calls to the server. Authorization is nulled and the
 *    person's key restated, which wins over both.
 */
export function personAnthropicClient(
  apiKey: string,
  options: Omit<ClientOptions, 'apiKey' | 'authToken' | 'defaultHeaders'> = {},
): Anthropic {
  return new Anthropic({
    apiKey,
    authToken: null,
    ...options,
    defaultHeaders: { Authorization: null, 'X-Api-Key': apiKey },
  })
}
