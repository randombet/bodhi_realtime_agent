import type { LanguageModelV1 } from 'ai';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_REMINDER_FRACTIONS,
	resolveInterviewConfig,
} from '../../app/agents/interview/interview-config.js';
import {
	DEFAULT_INTERVIEW_OPTIONS,
	InterviewConfigError,
} from '../../app/agents/interview/interview-options.js';

const fakeModel = {} as unknown as LanguageModelV1;
const docs = { jobDescription: '# Role', candidateResume: '# Cand', companyIntro: '# Co' };
const base = { documents: docs, durationMinutes: 30, reasoning: { model: fakeModel } } as const;

describe('resolveInterviewConfig', () => {
	it('fills structure from DEFAULT_INTERVIEW_OPTIONS when omitted and threads durationMinutes', () => {
		const rc = resolveInterviewConfig({ ...base, durationMinutes: 40 });
		expect(rc.structure.maxSections).toBe(DEFAULT_INTERVIEW_OPTIONS.maxSections);
		expect(rc.structure.durationMinutes).toBe(40);
		expect(rc.structure.effectiveMaxSections).toBe(DEFAULT_INTERVIEW_OPTIONS.maxSections);
	});

	it('derives reminderSchedule from durationMinutes × DEFAULT_REMINDER_FRACTIONS when neither is given', () => {
		const rc = resolveInterviewConfig({ ...base, durationMinutes: 20 });
		expect(rc.reminderSchedule).toEqual(
			DEFAULT_REMINDER_FRACTIONS.map((f) => Math.round(20 * f)).sort((a, b) => a - b),
		);
		expect(rc.reminderSchedule).toEqual([10, 16, 19]);
	});

	it('uses reminderFractions when given', () => {
		const rc = resolveInterviewConfig({
			...base,
			durationMinutes: 60,
			reminderFractions: [0.25, 0.75],
		});
		expect(rc.reminderSchedule).toEqual([15, 45]);
	});

	it('uses an explicit reminderSchedule verbatim (sorted-unique) and ignores fractions/duration', () => {
		const rc = resolveInterviewConfig({
			...base,
			durationMinutes: 1000,
			reminderFractions: [0.5],
			reminderSchedule: [25, 5, 25, 15],
		});
		expect(rc.reminderSchedule).toEqual([5, 15, 25]);
	});

	it('empty reminderSchedule / reminderFractions ⇒ no reminders', () => {
		expect(resolveInterviewConfig({ ...base, reminderSchedule: [] }).reminderSchedule).toEqual([]);
		expect(resolveInterviewConfig({ ...base, reminderFractions: [] }).reminderSchedule).toEqual([]);
	});

	it('throws InterviewConfigError on durationMinutes ≤ 0 or non-finite', () => {
		expect(() => resolveInterviewConfig({ ...base, durationMinutes: 0 })).toThrow(
			InterviewConfigError,
		);
		expect(() => resolveInterviewConfig({ ...base, durationMinutes: -5 })).toThrow(
			InterviewConfigError,
		);
		expect(() => resolveInterviewConfig({ ...base, durationMinutes: Number.NaN })).toThrow(
			InterviewConfigError,
		);
	});

	it('throws InterviewConfigError on bad reminderFractions / reminderSchedule entries', () => {
		expect(() => resolveInterviewConfig({ ...base, reminderFractions: [0, 0.5] })).toThrow(
			InterviewConfigError,
		);
		expect(() => resolveInterviewConfig({ ...base, reminderFractions: [1.5] })).toThrow(
			InterviewConfigError,
		);
		expect(() => resolveInterviewConfig({ ...base, reminderSchedule: [-1] })).toThrow(
			InterviewConfigError,
		);
		expect(() => resolveInterviewConfig({ ...base, reminderSchedule: [Number.NaN] })).toThrow(
			InterviewConfigError,
		);
	});

	it('throws when reasoning.model is missing', () => {
		expect(() =>
			resolveInterviewConfig({ documents: docs, durationMinutes: 30, reasoning: {} as never }),
		).toThrow(InterviewConfigError);
	});

	it('propagates the briefSanitization report up from resolveInterviewEngineOptions', () => {
		expect(resolveInterviewConfig(base).briefSanitization).toBeUndefined();
		const rc = resolveInterviewConfig({ ...base, structure: { interviewerBrief: '  a   b  ' } });
		expect(rc.structure.interviewerBrief).toBe('a b');
		expect(rc.briefSanitization?.sanitized).toBe(true);
	});

	it('forwards InterviewEngineOptions validation (e.g. maxSections < 2)', () => {
		expect(() => resolveInterviewConfig({ ...base, structure: { maxSections: 1 } })).toThrow(
			InterviewConfigError,
		);
	});
});
