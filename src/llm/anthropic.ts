import { BaseLLMClient } from './base';
import { LLMConfig, Message, LLMResponse, StreamingResponse } from './types';
import { LLMStreamEmitter } from './base';
import Anthropic from '@anthropic-ai/sdk';

import { Logger } from '../utils/logger';

export class AnthropicClient extends BaseLLMClient {
    private client: Anthropic | null = null;

    constructor(config: LLMConfig) {
        super(config);

        const apiKey = this.getApiKey('anthropic');
        if (apiKey) {
            this.client = new Anthropic({
                apiKey: apiKey
            });
        }
    }

    /*
      export interface MessageParam {
        content: string | Array<TextBlock | ImageBlockParam>;

        role: 'user' | 'assistant';
      }

     * -- Regular content
     * ```json
     * { "role": "user", "content": "Hello, Claude" }
     * ```
     *
     * -- Structured content
     * ```json
     * { "role": "user", "content": [{ "type": "text", "text": "Hello, Claude" }] }
     * ```
     *
     * -- Multimedia content
     * {
     *   "role": "user",
     *   "content": [
     *     {
     *       "type": "image",
     *       "source": {
     *         "type": "base64",
     *         "media_type": "image/jpeg",
     *         "data": "/9j/4AAQSkZJRg..."
     *       }
     *     },
     *     { "type": "text", "text": "What is in this image?" }
     *   ]
     * }
     */

    sendStream(messages: Message[], config?: Partial<LLMConfig>): StreamingResponse {
        const emitter = new LLMStreamEmitter();
        const logger = Logger.getInstance();

        if (!this.client) {
            process.nextTick(() => {
                emitter.emit('error', new Error('Anthropic client not initialized. API key may be missing.'));
            });
            return emitter;
        }

        const client = this.client;

        const mergedConfig = {
            ...this.config,
            ...config
        };

        // Start the streaming process
        (async () => {
            try {
                // Convert messages to Anthropic format
                const formattedMessages = messages
                    .filter(msg => msg.role !== 'system')
                    .map(msg => ({
                        role: msg.role === 'assistant' ? 'assistant' as const : 'user' as const,
                        content: msg.content
                    }));

                // System message needs special handling
                const systemMessage = messages.find(msg => msg.role === 'system');
                const systemPrompt = systemMessage?.content;

                // Make sure max_tokens is a number and not undefined
                const maxTokens = mergedConfig.maxTokens || 1024;

                const stream = client.messages.stream({
                    model: mergedConfig.modelName,
                    messages: formattedMessages,
                    system: systemPrompt,
                    max_tokens: maxTokens,
                    temperature: mergedConfig.temperature,
                });

                let fullContent = '';
                let usage: {
                    promptTokens: number;
                    completionTokens: number;
                    totalTokens: number;
                } = {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0
                };

                for await (const chunk of stream) {
                    if (chunk.type === 'content_block_delta') {
                        if ('text' in chunk.delta) {
                            const text = chunk.delta?.text || '';
                            fullContent += text;
                            emitter.emit('data', text);
                            logger.log('debug', 'Anthropic chunk:', { chunk: chunk });
                        }
                    }

                    if (chunk.type === 'message_delta') {
                        usage.completionTokens += chunk.usage?.output_tokens || 0;
                        logger.log('debug', 'Anthropic usage:', { chunk: chunk });
                        // usage = {
                        //     promptTokens: chunk.usage?.input_tokens || 0,
                        //     completionTokens: chunk.usage?.output_tokens || 0,
                        //     totalTokens: (chunk.usage?.input_tokens || 0) + (chunk.usage?.output_tokens || 0)
                        // };
                    }
                }

                // Emit the final response with complete content and usage statistics
                logger.log('debug', 'Anthropic final usage:', { usage: usage });
                emitter.emit('done', {
                    content: fullContent,
                    usage: usage
                });

            } catch (error) {
                console.error('Error in Anthropic stream:', error);
                emitter.emit('error', error);
            }
        })();

        return emitter;
    }

    async send(messages: Message[], config?: Partial<LLMConfig>): Promise<LLMResponse> {
        if (!this.client) {
            throw new Error('Anthropic client not initialized. API key may be missing.');
        }

        const mergedConfig = {
            ...this.config,
            ...config
        };

        try {
            // Convert messages to Anthropic format
            const formattedMessages = messages
                .filter(msg => msg.role !== 'system')
                .map(msg => ({
                    role: msg.role === 'assistant' ? 'assistant' as const : 'user' as const,
                    content: msg.content
                }));

            // System message needs special handling
            const systemMessage = messages.find(msg => msg.role === 'system');
            const systemPrompt = systemMessage?.content;

            // Make sure max_tokens is a number and not undefined
            const maxTokens = mergedConfig.maxTokens || 1024;

            const response = await this.client.messages.create({
                model: mergedConfig.modelName,
                messages: formattedMessages,
                system: systemPrompt,
                max_tokens: maxTokens,
                temperature: mergedConfig.temperature,
            });

            return {
                content: response.content[0] && 'text' in response.content[0]
                    ? response.content[0].text
                    : '',
                usage: {
                    // Anthropic may not provide detailed token usage in the same format
                    promptTokens: response.usage?.input_tokens ?? 0,
                    completionTokens: response.usage?.output_tokens ?? 0,
                    totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)
                }
            };
        } catch (error) {
            console.error('Error calling Anthropic API:', error);
            throw error;
        }
    }

    async isAvailable(): Promise<boolean> {
        return !!this.client;
    }
}
