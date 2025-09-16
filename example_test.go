package main

import (
	"strings"
	"testing"
)

func BenchmarkStringConcat(b *testing.B) {
	var result string
	for i := 0; i < b.N; i++ {
		result += "hello"
	}
}

func BenchmarkStringBuilder(b *testing.B) {
	var builder strings.Builder
	for i := 0; i < b.N; i++ {
		builder.WriteString("hello")
	}
	_ = builder.String()
}

func BenchmarkSliceAppend(b *testing.B) {
	var slice []string
	for i := 0; i < b.N; i++ {
		slice = append(slice, "hello")
	}
}

func BenchmarkMapAccess(b *testing.B) {
	m := make(map[string]int)
	for i := 0; i < 1000; i++ {
		m[string(rune(i))] = i
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = m["500"]
	}
}
