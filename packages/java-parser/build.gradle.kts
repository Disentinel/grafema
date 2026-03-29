plugins {
    java
    application
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

application {
    mainClass.set("com.grafema.parser.Main")
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.github.javaparser:javaparser-core:3.26.2")
    implementation("com.google.code.gson:gson:2.11.0")
}

tasks.jar {
    manifest {
        attributes["Main-Class"] = "com.grafema.parser.Main"
    }
    // Create fat jar
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) })
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}
