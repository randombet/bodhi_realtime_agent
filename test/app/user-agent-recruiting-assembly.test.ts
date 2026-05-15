// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	applyUserAgentRecruitingStudioSyncLayer,
	expandRecruitingStudioMacros,
	resolveUserAgentRecruitingMacroDocuments,
} from '../../app/agents/runtime/user-agent-recruiting-assembly.js';
import type { MainAgent } from '../../src/types/agent.js';

function mainWithInstructions(instr: string): MainAgent[] {
	return [
		{
			name: 'main',
			instructions: instr,
			greeting: 'hi',
			tools: [],
			googleSearch: false,
		},
	];
}

describe('user-agent-recruiting-assembly', () => {
	it('resolveUserAgentRecruitingMacroDocuments prefers interview when both are present', () => {
		const d = resolveUserAgentRecruitingMacroDocuments({
			recruitingDraft: { companyMd: 'D', jobDescriptionMd: 'J1', candidateResumeMd: 'R1' },
			interview: {
				companyIntroMd: 'I',
				jobDescriptionMd: 'J2',
				candidateResumeMd: 'R2',
				anchors: [],
			},
		});
		expect(d).toEqual({ company: 'I', job: 'J2', resume: 'R2' });
	});

	it('expandRecruitingStudioMacros fills all three slots', () => {
		const s = expandRecruitingStudioMacros(
			'Co {{COMPANY_INFO}} / Jo {{JOB_DESCRIPTION}} / Re {{RESUME}}',
			{
				company: ' A ',
				job: ' B ',
				resume: ' C ',
			},
		);
		expect(s).toBe('Co A / Jo B / Re C');
	});

	it('with draft only: prepends three screening pillar docs', () => {
		const out = applyUserAgentRecruitingStudioSyncLayer(mainWithInstructions('x'), {
			recruitingDraft: { companyMd: 'c', jobDescriptionMd: 'j', candidateResumeMd: 'r' },
		});
		const main = out.find((a) => a.name === 'main');
		expect(main?.knowledgeBase?.documents).toHaveLength(3);
	});

	it('with interview only: expands macros, does not prepend screening pillars', () => {
		const out = applyUserAgentRecruitingStudioSyncLayer(mainWithInstructions('{{COMPANY_INFO}}'), {
			interview: {
				companyIntroMd: 'FromInterview',
				jobDescriptionMd: 'j',
				candidateResumeMd: 'r',
			},
		});
		const main = out.find((a) => a.name === 'main');
		expect(main?.instructions).toBe('FromInterview');
		expect(main?.knowledgeBase?.documents).toBeUndefined();
	});

	it('with draft + interview: macros use interview; no screening pillar prepend', () => {
		const out = applyUserAgentRecruitingStudioSyncLayer(
			mainWithInstructions('Co {{COMPANY_INFO}}'),
			{
				recruitingDraft: { companyMd: 'DRAFT_CO', jobDescriptionMd: 'd', candidateResumeMd: 'd' },
				interview: {
					companyIntroMd: 'INTERVIEW_CO',
					jobDescriptionMd: 'j',
					candidateResumeMd: 'r',
				},
			},
		);
		const main = out.find((a) => a.name === 'main');
		expect(main?.instructions).toBe('Co INTERVIEW_CO');
		expect(main?.knowledgeBase?.documents).toBeUndefined();
	});
});
