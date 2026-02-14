/** UI response from client button taps / form submissions */
export interface UIResponse {
	requestId: string;
	selectedOptionId?: string;
	formData?: Record<string, unknown>;
}
