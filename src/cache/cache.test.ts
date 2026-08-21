import { describe, expect, it } from "bun:test";
import { calculateLevenshteinDistance, calculateSimilarity, normalizeSearchQuery } from "./index";
import { extractYouTubeVideoId } from "../transformers";

describe("Levenshtein & Fuzzy Search Typo Matching", () => {
    it("should calculate exact matches with distance 0 and similarity 1.0", () => {
        const query = "sweet dreams are made of this";
        expect(calculateLevenshteinDistance(query, query)).toBe(0);
        expect(calculateSimilarity(query, query)).toBe(1.0);
    });

    it("should match typo 'swwet dreams are nade of these' with high similarity (>= 85%)", () => {
        const canonical = normalizeSearchQuery("dzsearch:sweet dreams are made of these").cleanQuery;
        const typo = normalizeSearchQuery("dzsearch:swwet dreams are nade of these").cleanQuery;

        const distance = calculateLevenshteinDistance(canonical, typo);
        const similarity = calculateSimilarity(canonical, typo);

        expect(distance).toBe(2); // 'w' instead of 'e', 'n' instead of 'm'
        expect(similarity).toBeGreaterThanOrEqual(0.85);
    });

    it("should NOT match distinct queries with extra keywords like 'by marilyn manson'", () => {
        const original = normalizeSearchQuery("dzsearch:sweet dreams are made of these").cleanQuery;
        const manson = normalizeSearchQuery("dzsearch:sweet dreams are made of these by marilyn manson").cleanQuery;

        const similarity = calculateSimilarity(original, manson);
        expect(similarity).toBeLessThan(0.70); // Very distinct search
    });

    it("should extract YouTube video ID from any YouTube URL format", () => {
        const id1 = extractYouTubeVideoId("https://music.youtube.com/watch?v=qeMFqkcPYcg");
        const id2 = extractYouTubeVideoId("https://www.youtube.com/watch?v=qeMFqkcPYcg&feature=youtu.be");
        const id3 = extractYouTubeVideoId("https://youtu.be/qeMFqkcPYcg");
        const id4 = extractYouTubeVideoId("https://youtube.com/shorts/qeMFqkcPYcg");

        expect(id1).toBe("qeMFqkcPYcg");
        expect(id2).toBe("qeMFqkcPYcg");
        expect(id3).toBe("qeMFqkcPYcg");
        expect(id4).toBe("qeMFqkcPYcg");
    });
});
