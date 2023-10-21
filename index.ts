import dotenv from 'dotenv'
dotenv.config()

import fs from 'fs'
import { parse as parseCsv } from 'csv-parse/sync'
import { Configuration as OpenAIConfig, OpenAIApi } from 'openai'
import Semaphore from 'semaphore-async-await'

const openaiConfig = new OpenAIConfig({ apiKey: process.env.OPENAI_API_KEY })
const openai = new OpenAIApi(openaiConfig)

const promptTrainingSafe = async (description: string, memo: string): Promise<boolean> => {
	const prompt = `
I'm mapping bank account transaction descriptions to human readable memos. Tell me if the memo includes information that is not included in the transaction description and needs extra context.

Transaction Description: ${description}
Human-Readable Memo: ${memo}
Needs Extra Context (Yes/No):
	`.trim()
	const completion = await openai.createCompletion({
		model: 'text-davinci-003',
		prompt,
		max_tokens: 1,
		echo: false,
		temperature: 0,
		top_p: 1
	})
	return (completion.data.choices[0].text ?? '').trim() !== 'Yes'
}

const classifyTrainingData = async () => {
	let safeData: any[] = []
	let unsafeData: any[] = []
	if (fs.existsSync('data/safe.json')) safeData = JSON.parse(fs.readFileSync('data/safe.json').toString())
	if (fs.existsSync('data/unsafe.json')) unsafeData = JSON.parse(fs.readFileSync('data/unsafe.json').toString())

	const csv = parseCsv(fs.readFileSync('data/txs.tsv'), {
		columns: [ 'id', '_', 'description', 'amountCents', '_', '_', '_', 'memo', '_' ],
		relaxQuotes: true,
		delimiter: '\t'
	})

	const lock = new (Semaphore as any as {default: any}).default(30)

	let i = 0
	const processRecord = async (record: any) => {
		i++
		await lock.acquire()

		const description = record.description.trim().replace(/\s+/g, ' ')
		const memo = record.memo.trim()
		const amountDollars = parseInt(record.amountCents.trim(), 10) / 100
		if (!/^\p{Emoji}/u.test(memo) || amountDollars > 0) return lock.release()
		if (safeData.some((r: any) => r.description === description && r.memo === memo && r.amountDollars === amountDollars)) return lock.release()
		if (unsafeData.some((r: any) => r.description === description && r.memo === memo && r.amountDollars === amountDollars)) return lock.release()

		if (memo.includes('New user card fee') || await promptTrainingSafe(description, memo)) {
			console.log(`(${i}/${csv.length})   Safe: ${memo}`)
			safeData.push({ description, memo, amountDollars })
		} else {
			console.log(`(${i}/${csv.length}) Unsafe: ${memo}`)
			unsafeData.push({ description, memo, amountDollars })
		}

		fs.writeFileSync('data/safe.json', JSON.stringify(safeData, null, 2))
		fs.writeFileSync('data/unsafe.json', JSON.stringify(unsafeData, null, 2))

		lock.release()
	}

	await Promise.all(csv.map(processRecord))
	console.log('Done!')
}

const fixEmoji = async () => {
	fs.writeFileSync(
		'data/safe-emojifix.json',
		JSON.stringify(JSON.parse(fs.readFileSync('data/safe.json').toString()).map((r: any) => {
			const [, emoji, rest ] = r.memo.match(/^(\p{Emoji})\s*(.*)/u)
			return { ...r, memo: `${emoji} ${rest}` }
		}), null, 2)
	)
}

const randomSampleDedupe = async () => {
	const parsed = JSON.parse(fs.readFileSync('data/safe-emojifix.json').toString())
	console.log(`Total count: ${parsed.length}`)

	const byMemo: Record<string, any> = {}
	for (const r of parsed) {
		if (!byMemo[r.memo]) byMemo[r.memo] = []
		byMemo[r.memo].push(r)
	}

	const final: any[] = []

	for (let records of Object.values(byMemo)) {
		records = records as any[]
		// Shuffle the records
		for (let i = records.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1))
			;[records[i], records[j]] = [records[j], records[i]]
		}
		final.push(...records.slice(0, 10))
	}

	console.log(`New count: ${final.length}`)
	fs.writeFileSync('data/safe-deduped.json', JSON.stringify(final, null, 2))
}

const prepareJsonl = async () => {
	const parsed = JSON.parse(fs.readFileSync('data/safe-deduped.json').toString())
	const lines = parsed.map((r: any) => ({
		prompt: `Amount: $${(-r.amountDollars).toFixed(2)}\nTransaction Description: ${r.description}\nHuman-Readable Memo:`,
		completion: ' ' + r.memo
	}))
	fs.writeFileSync('data/finetuning.jsonl', lines.map((l: any) => JSON.stringify(l)).join('\n'))
}

prepareJsonl().catch(err => {
	if (err.isAxiosError)
		console.error(err.response?.data || err) 
	else 
		console.error(err)
})