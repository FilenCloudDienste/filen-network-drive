export type RCVFSStats = {
	diskCache: RCVFSStatsDiskCache
	fs: string
	inUse: number
	metadataCache: RCVFSStatsMetadataCache
	opt: RCVFSStatsOpt
}

export type RCVFSStatsDiskCache = {
	bytesUsed: number
	erroredFiles: number
	files: number
	hashType: number
	outOfSpace: boolean
	path: string
	pathMeta: string
	uploadsInProgress: number
	uploadsQueued: number
}

export type RCVFSStatsMetadataCache = {
	dirs: number
	files: number
}

export type RCVFSStatsOpt = {
	NoSeek: boolean
	NoChecksum: boolean
	ReadOnly: boolean
	NoModTime: boolean
	DirCacheTime: number
	Refresh: boolean
	PollInterval: number
	Umask: number
	UID: number
	GID: number
	DirPerms: number
	FilePerms: number
	ChunkSize: number
	ChunkSizeLimit: number
	CacheMode: number
	CacheMaxAge: number
	CacheMaxSize: number
	CacheMinFreeSpace: number
	CachePollInterval: number
	CaseInsensitive: boolean
	BlockNormDupes: boolean
	WriteWait: number
	ReadWait: number
	WriteBack: number
	ReadAhead: number
	UsedIsSize: boolean
	FastFingerprint: boolean
	DiskSpaceTotalSize: number
}

export type RCCoreStats = {
	bytes: number
	checks: number
	deletedDirs: number
	deletes: number
	elapsedTime: number
	errors: number
	eta: number
	fatalError: boolean
	renames: number
	retryError: boolean
	serverSideCopies: number
	serverSideCopyBytes: number
	serverSideMoveBytes: number
	serverSideMoves: number
	speed: number
	totalBytes: number
	totalChecks: number
	totalTransfers: number
	transferTime: number
	transferring: RCCoreStatsTransferring[] | null | undefined
	transfers: number
}

export type RCCoreStatsTransferring = {
	bytes: number
	dstFs: string
	eta: null | undefined | number
	group: string
	name: string
	percentage: number
	size: number
	speed: number
	speedAvg: number
	srcFs: string
}
